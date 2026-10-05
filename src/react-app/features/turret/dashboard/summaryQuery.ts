import type { UseQueryResult } from "@tanstack/react-query";
import type { TurretSummary } from "../../../lib/turretApi";

// Dashboard views consume query state and can trigger a refresh; they do not consume the refetch result.
export type SummaryQuery = Pick<
	UseQueryResult<TurretSummary>,
	"data" | "isError" | "isFetching" | "isRefetchError" | "dataUpdatedAt"
> & { refetch: () => Promise<unknown> };
