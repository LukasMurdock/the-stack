import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { ApiError, jsonOrThrow } from "../../src/react-app/api";
test("non-JSON errors retain HTTP status and successful responses validate their contract", async () => {
	await assert.rejects(
		() =>
			jsonOrThrow(
				new Response("Unavailable", { status: 503 }),
				z.object({ ok: z.boolean() })
			),
		(error) =>
			error instanceof ApiError &&
			error.status === 503 &&
			error.message.includes("503")
	);
	await assert.rejects(
		() =>
			jsonOrThrow(
				Response.json({ ok: "wrong" }),
				z.object({ ok: z.boolean() })
			),
		z.ZodError
	);
	await assert.rejects(
		() =>
			jsonOrThrow(
				Response.json(
					{
						error: {
							code: "invalid_input",
							message: "Check name",
							fields: { name: "Required" },
						},
					},
					{ status: 400 }
				)
			),
		(error) =>
			error instanceof ApiError && error.fields?.name === "Required"
	);
});

test("shared transport accepts request metadata without depending on its producer", async (t) => {
	const { apiClient, setApiRequestHeaders } =
		await import("../../src/react-app/api");
	const received: Headers[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (_url: unknown, init?: RequestInit) => {
			received.push(new Headers(init?.headers));
			return Response.json({ ok: true });
		}
	);
	t.after(() => setApiRequestHeaders(() => ({})));
	await apiClient.health.$get();
	assert.equal(received[0]?.has("x-request-context"), false);
	let context = "first";
	setApiRequestHeaders(() => ({ "x-request-context": context }));
	await apiClient.health.$get();
	context = "second";
	await apiClient.health.$get();
	assert.equal(received[1]?.get("x-request-context"), "first");
	assert.equal(received[2]?.get("x-request-context"), "second");
});

test("response decoding accepts wire data and returns transformed output", async () => {
	const decoder = z
		.object({ createdAt: z.string() })
		.transform(({ createdAt }) => new Date(createdAt));
	const date = await jsonOrThrow(
		Response.json({ createdAt: "2026-10-06T00:00:00.000Z" }),
		decoder
	);
	assert.ok(date instanceof Date);
	assert.equal(date.toISOString(), "2026-10-06T00:00:00.000Z");
});
