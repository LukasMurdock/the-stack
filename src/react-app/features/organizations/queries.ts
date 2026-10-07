import {
	mutationOptions,
	queryOptions,
	type QueryClient,
} from "@tanstack/react-query";
import type { InferRequestType } from "hono/client";
import { clearInvitationToken } from "./invitationToken";
import { apiClient, jsonOrThrow } from "../../api";
import {
	invitationsResponseSchema,
	membersResponseSchema,
	organizationResponseSchema,
	organizationsResponseSchema,
	invitationResponseSchema,
	acknowledgementSchema,
} from "../../../contracts/organizations";

const organizations = apiClient.organizations;
const organization = organizations[":organizationId"];
const member = organization.members[":userId"];

export const organizationKeys = {
	all: (userId: string) => ["organizations", userId] as const,
	detail: (userId: string, organizationId: string) =>
		["organizations", userId, organizationId] as const,
};

export function createOrganizationMutation(
	queryClient: QueryClient,
	userId: string
) {
	return mutationOptions({
		mutationFn: async (
			fields: InferRequestType<typeof organizations.$post>["json"]
		) =>
			jsonOrThrow(
				await organizations.$post({ json: fields }),
				organizationResponseSchema
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: organizationKeys.all(userId),
			}),
	});
}

export function changeMemberMutation(
	queryClient: QueryClient,
	userId: string,
	organizationId: string
) {
	return mutationOptions({
		mutationFn: async (
			input: { userId: string } & InferRequestType<
				typeof member.$put
			>["json"]
		) =>
			jsonOrThrow(
				await member.$put({
					param: { organizationId, userId: input.userId },
					json: { role: input.role },
				}),
				acknowledgementSchema
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: organizationKeys.detail(userId, organizationId),
			}),
	});
}

export function removeMemberMutation(
	queryClient: QueryClient,
	userId: string,
	organizationId: string
) {
	return mutationOptions({
		mutationFn: async (memberId: string) =>
			jsonOrThrow(
				await member.$delete({
					param: { organizationId, userId: memberId },
				}),
				acknowledgementSchema
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: organizationKeys.detail(userId, organizationId),
			}),
	});
}

export function inviteMemberMutation(
	queryClient: QueryClient,
	userId: string,
	organizationId: string
) {
	return mutationOptions({
		mutationFn: async (
			fields: InferRequestType<
				typeof organization.invitations.$post
			>["json"]
		) =>
			jsonOrThrow(
				await organization.invitations.$post({
					param: { organizationId },
					json: fields,
				}),
				invitationResponseSchema
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: organizationKeys.detail(userId, organizationId),
			}),
	});
}

export function revokeInvitationMutation(
	queryClient: QueryClient,
	userId: string,
	organizationId: string
) {
	return mutationOptions({
		mutationFn: async (invitationId: string) =>
			jsonOrThrow(
				await organization.invitations[":invitationId"].$delete({
					param: { organizationId, invitationId },
				}),
				acknowledgementSchema
			),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: organizationKeys.detail(userId, organizationId),
			}),
	});
}

export function acceptInvitationMutation(
	queryClient: QueryClient,
	userId: string,
	token: string
) {
	return mutationOptions({
		mutationKey: ["invitations", "accept"],
		mutationFn: async () =>
			jsonOrThrow(
				await apiClient.invitations.accept.$post({ json: { token } }),
				organizationResponseSchema
			),
		onSuccess: () => {
			clearInvitationToken();
			return queryClient.invalidateQueries({
				queryKey: organizationKeys.all(userId),
			});
		},
	});
}

export function organizationsQuery(userId: string, offset = 0) {
	return queryOptions({
		queryKey: [...organizationKeys.all(userId), "list", offset],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await organizations.$get(
					{ query: { offset } },
					{ init: { signal } }
				),
				organizationsResponseSchema
			),
		retry: false,
	});
}
export function organizationQuery(userId: string, organizationId: string) {
	return queryOptions({
		queryKey: [
			...organizationKeys.detail(userId, organizationId),
			"detail",
		],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await organization.$get(
					{ param: { organizationId } },
					{ init: { signal } }
				),
				organizationResponseSchema
			),
		retry: false,
	});
}
export function membersQuery(
	userId: string,
	organizationId: string,
	offset = 0
) {
	return queryOptions({
		queryKey: [
			...organizationKeys.detail(userId, organizationId),
			"members",
			offset,
		],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await organization.members.$get(
					{ param: { organizationId }, query: { offset } },
					{ init: { signal } }
				),
				membersResponseSchema
			),
		retry: false,
	});
}

export function invitationsQuery(
	userId: string,
	organizationId: string,
	offset = 0
) {
	return queryOptions({
		queryKey: [
			...organizationKeys.detail(userId, organizationId),
			"invitations",
			offset,
		],
		queryFn: async ({ signal }) =>
			jsonOrThrow(
				await organization.invitations.$get(
					{ param: { organizationId }, query: { offset } },
					{ init: { signal } }
				),
				invitationsResponseSchema
			),
		retry: false,
	});
}
