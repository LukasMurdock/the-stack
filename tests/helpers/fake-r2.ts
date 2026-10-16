// An in-memory R2Bucket for Worker tests. It implements the conditional
// put/get, list and delete semantics routes depend on, and throws for
// features it does not model so a test cannot pass by accident.

// R2 limits: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
export const R2_LIST_LIMIT_MAX = 1000;
export const R2_DELETE_KEYS_MAX = 1000;

export type FakeR2Object = {
	readonly bytes: Uint8Array;
	readonly etag: string;
	readonly uploaded: Date;
	readonly httpMetadata: R2HTTPMetadata;
	// Tests may replace an entry without this metadata to simulate legacy objects.
	readonly customMetadata: Record<string, string>;
};

type PutValue = Parameters<R2Bucket["put"]>[1];

function unsupported(feature: string): never {
	throw new Error(`FakeR2Bucket does not support ${feature}.`);
}

function conditional(onlyIf: R2Conditional | Headers | undefined) {
	if (onlyIf === undefined) return undefined;
	if (onlyIf instanceof Headers) return unsupported("Headers conditions");
	if (onlyIf.uploadedBefore || onlyIf.uploadedAfter)
		return unsupported("upload-time conditions");
	return onlyIf;
}

// "*" matches any existing object, as in HTTP If-Match/If-None-Match.
function etagMatches(etag: string | undefined, condition: string) {
	return etag !== undefined && (condition === "*" || condition === etag);
}

function passes(object: FakeR2Object | undefined, onlyIf?: R2Conditional) {
	if (onlyIf?.etagMatches !== undefined)
		if (!etagMatches(object?.etag, onlyIf.etagMatches)) return false;
	if (onlyIf?.etagDoesNotMatch !== undefined)
		if (etagMatches(object?.etag, onlyIf.etagDoesNotMatch)) return false;
	return true;
}

async function readBytes(value: PutValue): Promise<Uint8Array> {
	if (value === null) return new Uint8Array();
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value))
		return new Uint8Array(
			value.buffer.slice(
				value.byteOffset,
				value.byteOffset + value.byteLength
			)
		);
	return new Uint8Array(await new Response(value).arrayBuffer());
}

function metadataObject(key: string, object: FakeR2Object): R2Object {
	return {
		key,
		version: object.etag,
		size: object.bytes.byteLength,
		etag: object.etag,
		httpEtag: `"${object.etag}"`,
		checksums: { toJSON: () => ({}) },
		uploaded: object.uploaded,
		httpMetadata: object.httpMetadata,
		customMetadata: object.customMetadata,
		storageClass: "Standard",
		writeHttpMetadata(headers: Headers) {
			const { contentType } = object.httpMetadata;
			if (contentType) headers.set("Content-Type", contentType);
		},
	};
}

function bodyObject(key: string, object: FakeR2Object): R2ObjectBody {
	let used = false;
	// Like a platform body, the content can be consumed once.
	function consume() {
		if (used) throw new TypeError("R2 object body already used.");
		used = true;
		return object.bytes.slice();
	}
	const metadata = metadataObject(key, object);
	return {
		...metadata,
		writeHttpMetadata: (headers: Headers) =>
			metadata.writeHttpMetadata(headers),
		get body() {
			return new Response(consume()).body ?? unsupported("empty bodies");
		},
		get bodyUsed() {
			return used;
		},
		arrayBuffer: async () => consume().buffer,
		bytes: async () => consume(),
		text: async () => new TextDecoder().decode(consume()),
		json: async () => JSON.parse(new TextDecoder().decode(consume())),
		blob: async () => new Blob([consume()]),
	};
}

export class FakeR2Bucket implements R2Bucket {
	readonly objects = new Map<string, FakeR2Object>();
	// Keys of successful puts and of gets that returned a body, in call order.
	readonly writtenKeys: string[] = [];
	readonly readKeys: string[] = [];
	readonly #beforeDelete: (key: string) => void;
	#version = 0;

	// beforeDelete runs per key before removal; throwing simulates an R2 failure
	// partway through a batch.
	constructor(beforeDelete: (key: string) => void = () => {}) {
		this.#beforeDelete = beforeDelete;
	}

	text(key: string): string | undefined {
		const object = this.objects.get(key);
		return object && new TextDecoder().decode(object.bytes);
	}

	async head(key: string): Promise<R2Object | null> {
		const object = this.objects.get(key);
		return object ? metadataObject(key, object) : null;
	}

	get(
		key: string,
		options: R2GetOptions & { onlyIf: R2Conditional | Headers }
	): Promise<R2ObjectBody | R2Object | null>;
	get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
	async get(
		key: string,
		options?: R2GetOptions
	): Promise<R2ObjectBody | R2Object | null> {
		if (options?.range !== undefined) unsupported("range reads");
		if (options?.ssecKey !== undefined) unsupported("SSE-C keys");
		const object = this.objects.get(key);
		if (!object) return null;
		if (!passes(object, conditional(options?.onlyIf)))
			return metadataObject(key, object);
		this.readKeys.push(key);
		return bodyObject(key, object);
	}

	put(
		key: string,
		value: PutValue,
		options?: R2PutOptions & { onlyIf: R2Conditional | Headers }
	): Promise<R2Object | null>;
	put(
		key: string,
		value: PutValue,
		options?: R2PutOptions
	): Promise<R2Object>;
	async put(
		key: string,
		value: PutValue,
		options?: R2PutOptions
	): Promise<R2Object | null> {
		if (options?.httpMetadata instanceof Headers)
			unsupported("Headers metadata");
		const onlyIf = conditional(options?.onlyIf);
		const bytes = await readBytes(value);
		// No await between the check and the write: concurrent puts serialize.
		if (!passes(this.objects.get(key), onlyIf)) return null;
		this.#version++;
		const object: FakeR2Object = {
			bytes,
			etag: `fake-${this.#version}`,
			uploaded: new Date(),
			httpMetadata: options?.httpMetadata ?? {},
			customMetadata: { ...options?.customMetadata },
		};
		this.objects.set(key, object);
		this.writtenKeys.push(key);
		return metadataObject(key, object);
	}

	createMultipartUpload(): Promise<R2MultipartUpload> {
		return unsupported("multipart uploads");
	}

	resumeMultipartUpload(): R2MultipartUpload {
		return unsupported("multipart uploads");
	}

	async delete(keys: string | string[]): Promise<void> {
		const list = typeof keys === "string" ? [keys] : keys;
		if (list.length > R2_DELETE_KEYS_MAX)
			throw new RangeError(
				`R2 deletes at most ${R2_DELETE_KEYS_MAX} keys per call.`
			);
		for (const key of list) {
			this.#beforeDelete(key);
			// oxlint-disable-next-line drizzle/enforce-delete-with-where -- Removes one key from an in-memory Map.
			this.objects.delete(key);
		}
	}

	async list(options?: R2ListOptions): Promise<R2Objects> {
		if (options?.delimiter !== undefined) unsupported("delimiters");
		const limit = options?.limit ?? R2_LIST_LIMIT_MAX;
		if (!Number.isInteger(limit) || limit < 1 || limit > R2_LIST_LIMIT_MAX)
			throw new RangeError(
				`R2 list limit must be 1-${R2_LIST_LIMIT_MAX}, got ${limit}.`
			);
		const prefix = options?.prefix ?? "";
		// The cursor is the last key of the previous page.
		const after = options?.cursor ?? options?.startAfter ?? "";
		const keys = [...this.objects.keys()]
			.filter((key) => key.startsWith(prefix) && key > after)
			.sort();
		const page = keys.slice(0, limit);
		const objects = page.map((key) => {
			const object = this.objects.get(key);
			if (!object) throw new Error(`Listed key vanished: ${key}`);
			return metadataObject(key, object);
		});
		const last = page.at(-1);
		if (keys.length > limit && last !== undefined)
			return {
				objects,
				delimitedPrefixes: [],
				truncated: true,
				cursor: last,
			};
		return { objects, delimitedPrefixes: [], truncated: false };
	}
}
