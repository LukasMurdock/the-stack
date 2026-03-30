import { z } from "zod";

const uploadTokenPayloadSchema = z.object({
	sid: z.string().min(1),
	exp: z.number().finite(),
	pv: z.string().min(1),
});

type UploadTokenPayload = z.infer<typeof uploadTokenPayloadSchema>;

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	const b64 = btoa(binary);
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToBytes(b64url: string): Uint8Array {
	const b64 = b64url
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(b64url.length / 4) * 4, "=");
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
	const keyBytes = new TextEncoder().encode(key);
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		new TextEncoder().encode(data)
	);

	const bytes = new Uint8Array(sig);
	let hex = "";
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, "0");
	}
	return hex;
}

function timingSafeEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
	}
	return diff === 0;
}

async function signUploadToken(
	key: string,
	payload: UploadTokenPayload
): Promise<string> {
	const payloadJson = JSON.stringify(payload);
	const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadJson));
	const sigHex = await hmacSha256Hex(key, payloadB64);
	return `${payloadB64}.${sigHex}`;
}

async function verifyUploadToken(
	key: string,
	token: string,
	nowMs: number
): Promise<UploadTokenPayload | null> {
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [payloadB64, sigHex] = parts;

	const expected = await hmacSha256Hex(key, payloadB64);
	if (!timingSafeEqual(sigHex, expected)) return null;

	const payloadJson = new TextDecoder().decode(
		base64UrlDecodeToBytes(payloadB64)
	);

	let payloadUnknown: unknown;
	try {
		payloadUnknown = JSON.parse(payloadJson);
	} catch {
		return null;
	}
	const parsed = uploadTokenPayloadSchema.safeParse(payloadUnknown);
	if (!parsed.success) return null;
	const payload = parsed.data;

	if (nowMs >= payload.exp) return null;

	return payload;
}

export type { UploadTokenPayload };
export { signUploadToken, verifyUploadToken };
