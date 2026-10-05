import type { SecondaryStorage } from "better-auth";

function validateTtl(ttl: number): void {
	if (!Number.isSafeInteger(ttl) || ttl <= 0) {
		throw new TypeError("Auth storage TTL must be a positive integer");
	}
}

export function createAuthStorage(database: D1Database): SecondaryStorage {
	// Use the primary for every operation, including reads after revocation.
	// A replica or a KV fallback could return a token that was already consumed.
	const db = database;
	return {
		async get(key) {
			return db
				.prepare(`SELECT value FROM auth_storage
				WHERE key = ? AND (expires_at IS NULL OR expires_at > unixepoch())`)
				.bind(key)
				.first<string>("value");
		},
		async set(key, value, ttl) {
			if (ttl !== undefined) validateTtl(ttl);
			await db
				.prepare(`INSERT INTO auth_storage (key, value, expires_at)
				VALUES (?, ?, CASE WHEN ? IS NULL THEN NULL ELSE unixepoch() + ? END)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`)
				.bind(key, value, ttl ?? null, ttl ?? null)
				.run();
		},
		async delete(key) {
			await db
				.prepare("DELETE FROM auth_storage WHERE key = ?")
				.bind(key)
				.run();
		},
		async getAndDelete(key) {
			return db
				.prepare(`DELETE FROM auth_storage WHERE key = ?
				RETURNING CASE WHEN expires_at IS NULL OR expires_at > unixepoch()
				THEN value ELSE NULL END AS value`)
				.bind(key)
				.first<string>("value");
		},
		async increment(key, ttl) {
			validateTtl(ttl);
			const value = await db
				.prepare(`INSERT INTO auth_storage (key, value, expires_at)
				VALUES (?, '1', unixepoch() + ?)
				ON CONFLICT(key) DO UPDATE SET
					value = CASE WHEN expires_at <= unixepoch() THEN '1'
						ELSE CAST(CAST(value AS INTEGER) + 1 AS TEXT) END,
					expires_at = CASE WHEN expires_at <= unixepoch()
						THEN excluded.expires_at ELSE expires_at END
				RETURNING CAST(value AS INTEGER) AS count`)
				.bind(key, ttl)
				.first<number>("count");
			if (value === null)
				throw new Error("Auth storage increment returned no value");
			return value;
		},
	};
}

export async function cleanupAuthStorage(database: D1Database): Promise<void> {
	await database
		.prepare("DELETE FROM auth_storage WHERE expires_at <= unixepoch()")
		.run();
}
