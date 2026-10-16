import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiClient, jsonOrThrow } from "./api";
import {
	flagDefault,
	flagsClientSchema,
	type ClientFlagKey,
	type FlagValueOf,
} from "../contracts/feature-flags";

// Flags are evaluated by the Worker (GET /api/flags); the browser only reads
// the result. Values change on Flagship without a deploy, so they are
// refreshed after this long rather than cached for the session.
const FLAGS_STALE_MS = 60_000;

// The identity the flags are evaluated for. Keyed by user, so a different
// sign-in never reads the previous user's flags.
export type FlagScope = {
	readonly userId: string;
	readonly organizationId?: string;
};

export function flagsQuery(scope: FlagScope) {
	const { organizationId } = scope;
	return queryOptions({
		queryKey: ["flags", scope.userId, organizationId ?? null] as const,
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await apiClient.flags.$get(
					{
						query:
							organizationId === undefined
								? {}
								: { organizationId },
					},
					{ init: { signal } }
				),
				flagsClientSchema
			),
		staleTime: FLAGS_STALE_MS,
		retry: false,
	});
}

// The flag's evaluated value, or its registry default while loading and when
// the request fails, so unfinished work stays hidden until the Worker says so.
export function useFlag<Key extends ClientFlagKey>(
	key: Key,
	scope: FlagScope
): FlagValueOf<Key> {
	const query = useQuery(flagsQuery(scope));
	if (query.status !== "success") return flagDefault(key);
	const flags: { readonly [K in ClientFlagKey]: FlagValueOf<K> } =
		query.data.flags;
	return flags[key];
}
