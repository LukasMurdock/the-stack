import {
	mutationOptions,
	queryOptions,
	type QueryClient,
} from "@tanstack/react-query";
import type { InferRequestType } from "hono/client";
import { apiClient, jsonOrThrow } from "../../api";
import {
	projectResponseSchema,
	projectsResponseSchema,
} from "../../../features/projects/contracts";
import { organizationKeys } from "../organizations/queries";

const projects = apiClient.organizations[":organizationId"].projects;

const projectKeys = {
	all: (userId: string, organizationId: string) =>
		[
			...organizationKeys.detail(userId, organizationId),
			"projects",
		] as const,
};

export function createProjectMutation(
	queryClient: QueryClient,
	userId: string,
	organizationId: string
) {
	return mutationOptions({
		mutationFn: async (
			fields: InferRequestType<typeof projects.$post>["json"]
		) =>
			jsonOrThrow(
				await projects.$post({
					param: { organizationId },
					json: fields,
				}),
				projectResponseSchema
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: projectKeys.all(userId, organizationId),
			}),
	});
}

export function projectsQuery(
	userId: string,
	organizationId: string,
	offset = 0
) {
	return queryOptions({
		queryKey: [...projectKeys.all(userId, organizationId), offset],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await projects.$get(
					{ param: { organizationId }, query: { offset } },
					{ init: { signal } }
				),
				projectsResponseSchema
			),
		retry: false,
	});
}
