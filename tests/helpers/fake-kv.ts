// String get/put over a Map, counting writes, for code that uses only those.
export function fakeKv(initial: Record<string, string> = {}) {
	const stored = new Map(Object.entries(initial));
	let putsCount = 0;
	const kv = {
		async get(key: string): Promise<string | null> {
			return stored.get(key) ?? null;
		},
		async put(key: string, value: string): Promise<void> {
			putsCount += 1;
			stored.set(key, value);
		},
	};
	return {
		kv,
		// SAFETY: the code under test calls only string get and put.
		binding: kv as KVNamespace,
		stored,
		putsCount: () => putsCount,
	};
}
