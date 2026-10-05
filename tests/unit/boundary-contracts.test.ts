import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { getRequestLocation } from "../../src/lib/cloudflareRequest";
import { headerSessionSchema } from "../../src/contracts/auth";
import { turretInitResponseSchema } from "../../src/contracts/turret";
import { ApiError, jsonOrThrow } from "../../src/react-app/lib/apiClient";
import { decodeReplayEvents } from "../../src/react-app/features/turret/session/replayLoader";
import { parseReplaySearch } from "../../src/react-app/features/turret/session/replaySearch";
import { createSqliteD1, readSqlRow } from "../helpers/sqlite-d1";

test("Cloudflare location accepts string metadata and excludes invalid or absent values", () => {
	const request = new Request("https://example.com");
	assert.deepEqual(getRequestLocation(request), {
		country: undefined,
		colo: undefined,
	});
	Object.defineProperty(request, "cf", {
		configurable: true,
		value: { country: "US", colo: "IAD" },
	});
	assert.deepEqual(getRequestLocation(request), {
		country: "US",
		colo: "IAD",
	});
	Object.defineProperty(request, "cf", { value: { country: {}, colo: 42 } });
	assert.deepEqual(getRequestLocation(request), {
		country: undefined,
		colo: undefined,
	});
});

test("header sessions reject malformed user fields before reaching Astro locals", () => {
	assert.deepEqual(
		headerSessionSchema.parse({
			user: { name: null, email: "user@example.com" },
		}),
		{ user: { name: null, email: "user@example.com" } }
	);
	assert.equal(headerSessionSchema.parse(null), null);
	assert.equal(
		headerSessionSchema.safeParse({ user: { email: { value: "unsafe" } } })
			.success,
		false
	);
});

test("replay initialization uses the same parsed contract on the server and client", () => {
	const payload = {
		session_id: "session",
		upload_token: "token",
		policy_version: "v1",
		rrweb: { maskAllInputs: true },
	};
	assert.deepEqual(turretInitResponseSchema.parse(payload).console.level, [
		"log",
		"info",
		"warn",
		"error",
	]);
	assert.equal(
		turretInitResponseSchema.safeParse({
			...payload,
			console: { level: ["invalid"] },
		}).success,
		false
	);
	assert.equal(
		turretInitResponseSchema.safeParse({ ...payload, rrweb: null }).success,
		false
	);
});

test("shared replay schemas loaded before the server still generate OpenAPI", async () => {
	const { turretApp } = await import("../../src/worker/api/routes/turret");
	const document = turretApp.getOpenAPIDocument({
		openapi: "3.0.0",
		info: { title: "Replay contracts", version: "1" },
	});
	assert.ok(document.components?.schemas?.TurretInitResponse);
	assert.ok(document.paths["/turret/replay-session/init"]);
});

test("replay envelopes preserve rrweb payloads and reject invalid tags, timestamps, and missing data", () => {
	const event = {
		type: 6,
		timestamp: 123,
		data: {
			plugin: "rrweb/console@1",
			payload: { level: "log", payload: ["message"] },
		},
	};
	assert.equal(decodeReplayEvents([event])[0], event);
	assert.deepEqual(decodeReplayEvents([]), []);
	for (const invalid of [
		null,
		{ ...event, type: 8 },
		{ ...event, type: 1.5 },
		{ ...event, timestamp: NaN },
		{ type: 6, timestamp: 123 },
	]) {
		assert.throws(
			() => decodeReplayEvents([invalid]),
			/Invalid replay event envelope/
		);
	}
});

test("legacy replay filters survive parsing followed by a redirect to the canonical route", () => {
	const parsed = parseReplaySearch({
		q: "checkout",
		hasError: "1",
		grouped: "true",
		preset: "custom",
		from: "1000",
		to: "2000",
		offset: "50",
		limit: "25",
	});
	assert.deepEqual(parsed, {
		q: "checkout",
		hasError: true,
		groupBy: "user",
		preset: "custom",
		from: 1000,
		to: 2000,
		offset: 50,
		limit: 25,
	});
	assert.deepEqual(parseReplaySearch(parsed), parsed);
});

test("API error messages never treat arbitrary JSON fields as strings", async () => {
	for (const payload of [
		null,
		["message"],
		{ message: { private: "data" }, error: 42 },
	]) {
		await assert.rejects(
			jsonOrThrow(new Response(JSON.stringify(payload), { status: 500 })),
			(error: unknown) =>
				error instanceof ApiError &&
				error.message === "Request failed: 500"
		);
	}
	await assert.rejects(
		jsonOrThrow(
			new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
			})
		),
		(error: unknown) =>
			error instanceof ApiError &&
			error.message === "Forbidden" &&
			error.status === 403
	);
});

test("SQLite D1 batches roll back preceding writes when a later statement fails", async (t) => {
	const sqlite = new Database(":memory:");
	t.after(() => sqlite.close());
	sqlite.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
	const db = createSqliteD1(sqlite);
	await assert.rejects(
		db.batch([
			db.prepare("INSERT INTO items VALUES (?)").bind(1),
			db.prepare("INSERT INTO items VALUES (?)").bind(1),
		]),
		/UNIQUE constraint/
	);
	assert.equal(readSqlRow(sqlite, "SELECT count(*) AS n FROM items").n, 0);
});
