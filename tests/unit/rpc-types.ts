import { z } from "zod";
import {
	membersResponseSchema,
	organizationResponseSchema,
} from "../../src/contracts/organizations";
import type { InferRequestType } from "hono/client";
import { apiClient, jsonOrThrow } from "../../src/react-app/api";
import type { RouteLabel } from "../../src/worker/observability/route-label";

// @ts-expect-error Raw request paths are not authoritative route labels.
const rawRoute: RouteLabel = "/api/users/private-id";
void rawRoute;

// These compile-only checks protect route inference and success/error narrowing.
// An unused @ts-expect-error fails the test type check if a boundary becomes untyped.
async function checkRpcContracts() {
	const session = apiClient.turret["replay-session"][":id"];
	type Chunk = InferRequestType<typeof session.chunk.$post>["json"];
	const chunk: Chunk = { seq: 0, events: [] };
	void chunk;
	// @ts-expect-error The ingest schema requires a numeric sequence.
	const invalidChunk: Chunk = { seq: "zero", events: [] };
	void invalidChunk;
	// @ts-expect-error Upload authentication is part of the server request contract.
	session.chunk.$post({ param: { id: "session" }, json: chunk });
	// @ts-expect-error Internal endpoints are checked against the registered routes.
	apiClient.internal.turret.nonexistent.$get();
	const result = await jsonOrThrow(
		await apiClient.internal.turret["replay-session"][":id"].meta.$get({
			param: { id: "session" },
		})
	);
	const timestamp: string = result.session.startedAt;
	void timestamp;
	// @ts-expect-error Error bodies are excluded after jsonOrThrow succeeds.
	void result.error;
	const members = await apiClient.organizations[
		":organizationId"
	].members.$get({ param: { organizationId: "id" }, query: { offset: 0 } });
	const validated = await jsonOrThrow(members, membersResponseSchema);
	const name: string | undefined = validated.members[0]?.name;
	void name;
	// @ts-expect-error Runtime decoders must accept the RPC success payload.
	await jsonOrThrow(members, organizationResponseSchema);
	const organization = await apiClient.organizations[":organizationId"].$get({
		param: { organizationId: "id" },
	});
	const dateInput = organizationResponseSchema.extend({
		organization: organizationResponseSchema.shape.organization.extend({
			name: z.date(),
		}),
	});
	// @ts-expect-error A Date input cannot decode the wire string, even though Date serializes to string.
	await jsonOrThrow(organization, dateInput);
	const decoded = await jsonOrThrow(
		organization,
		organizationResponseSchema.transform(
			({ organization }) => organization.name.length
		)
	);
	const length: number = decoded;
	void length;

	const registration = await apiClient.invitations.register.$post({
		json: {
			token: "token",
			email: "user@example.test",
			name: "User",
			password: "password",
		},
	});
	// @ts-expect-error An opaque default response must not erase the declared JSON success type.
	await jsonOrThrow(registration, membersResponseSchema);
	const unknown = await jsonOrThrow(Response.json({ ok: true }));
	// @ts-expect-error A native Response provides no statically known JSON shape.
	void unknown.ok;
	// @ts-expect-error A caller-selected JSON type cannot substitute for response evidence.
	jsonOrThrow<{ invented: string }>(Response.json({ ok: true }));
}
void checkRpcContracts;
