import { expect, test } from "@playwright/test";
import { z } from "zod";
import { hc } from "hono/client";
import type { ApiType } from "../../src/worker/api";
import { jsonOrThrow } from "../../src/react-app/api";
import { REPLAY_CHUNK_TARGET_BYTES } from "../../src/contracts/turret-ingest";
import { turretReplayChunkSchema } from "../../src/contracts/turret";
import { turretComplianceSchema } from "../../src/contracts/turret-policy";

test("authenticated replay uploads survive a real Worker and R2 round trip", async ({
	request,
	baseURL,
}) => {
	if (!baseURL) throw new Error("The Worker base URL is required.");
	const signIn = await request.post("/api/auth/sign-in/email", {
		headers: { Origin: baseURL },
		data: {
			email: "admin@example.test",
			password: "Browser-test-password-123!",
		},
	});
	expect(signIn.ok()).toBe(true);
	const { token } = z
		.object({ token: z.string() })
		.parse(await signIn.json());
	const admin = hc<ApiType>(`${baseURL}/api`, {
		headers: { authorization: `Bearer ${token}`, Origin: baseURL },
	});
	const initialized = await jsonOrThrow(
		await admin.turret["replay-session"].init.$post({
			json: {
				journey_id: "rpc-round-trip",
				initial_url: `${baseURL}/app`,
			},
		})
	);
	const upload = hc<ApiType>(`${baseURL}/api`, {
		headers: { Origin: baseURL },
	});
	const session = upload.turret["replay-session"][":id"];
	const param = { id: initialized.session_id };
	const chunk = {
		seq: 0,
		events: [{ type: 2, timestamp: 123, data: { node: {} } }],
		ts_start: 123,
		ts_end: 123,
	};
	await jsonOrThrow(
		await session.chunk.$post({
			param,
			header: { authorization: `Bearer ${initialized.upload_token}` },
			json: chunk,
		})
	);
	// Identical retries acknowledge the existing commit. Different contents must
	// never replace the object or produce another metadata row.
	await jsonOrThrow(
		await session.chunk.$post({
			param,
			header: { authorization: `Bearer ${initialized.upload_token}` },
			json: chunk,
		})
	);
	const conflict = await session.chunk.$post({
		param,
		header: { authorization: `Bearer ${initialized.upload_token}` },
		json: { ...chunk, events: [] },
	});
	expect(conflict.status).toBe(409);
	const reader = admin.internal.turret["replay-session"][":id"];
	const stored = await jsonOrThrow(
		await reader.chunk[":seq"].$get({
			param: { ...param, seq: "0" },
		}),
		turretReplayChunkSchema
	);
	expect(stored).toEqual(chunk);
	const metadata = await jsonOrThrow(await reader.chunks.$get({ param }));
	expect(metadata.chunks).toHaveLength(1);
	const meta = await jsonOrThrow(await reader.meta.$get({ param }));
	expect(meta.session.chunkCount).toBe(1);
	const dashboard = await jsonOrThrow(
		await admin.internal.turret.dashboard.$get({ query: {} })
	);
	expect(dashboard.usersWithRetainedReplays24h).toBeGreaterThanOrEqual(1);
	expect(dashboard).not.toHaveProperty("activeUsersDeltaPct");

	const fingerprint = `rpc-triage-${crypto.randomUUID()}`;
	const ts = Date.now();
	await jsonOrThrow(
		await session.error.$post({
			param,
			header: { authorization: `Bearer ${initialized.upload_token}` },
			json: {
				ts,
				source: "client",
				message: "RPC triage round trip",
				fingerprint,
			},
		})
	);
	const erroredSession = await jsonOrThrow(await reader.meta.$get({ param }));
	expect(erroredSession.session.hasError).toBe(true);
	expect(erroredSession.session.errorCount).toBe(1);
	const triage = admin.internal.turret.issue[":fingerprint"];
	const issueParam = { fingerprint };
	const before = await jsonOrThrow(await triage.$get({ param: issueParam }));
	expect(before.issue.sample).toMatchObject({
		sessionId: initialized.session_id,
		source: "client",
		message: "RPC triage round trip",
		ts,
	});
	await Promise.all([
		triage
			.$patch({ param: issueParam, json: { status: "resolved" } })
			.then((response) => jsonOrThrow(response)),
		triage
			.$patch({ param: issueParam, json: { title: "Investigate RPC" } })
			.then((response) => jsonOrThrow(response)),
	]);
	const after = await jsonOrThrow(await triage.$get({ param: issueParam }));
	expect(after.issue.status).toBe("resolved");
	expect(after.issue.title).toBe("Investigate RPC");
	expect(after.issue.sample).toEqual(before.issue.sample);

	for (const seq of ["invalid", "-1", "0.5", "0x0", "0e0"]) {
		const response = await reader.chunk[":seq"].$get({
			param: { ...param, seq },
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_input" },
		});
	}

	const rejected = await session.chunk.$post({
		param,
		header: { authorization: "Bearer invalid" },
		json: { ...chunk, seq: 1 },
	});
	expect(rejected.status).toBe(401);
	const chunks = await jsonOrThrow(await reader.chunks.$get({ param }));
	expect(chunks.chunks.map(({ seq }) => seq)).toEqual([0]);
});

for (const failure of [
	"overflow",
	"blocked import",
	"recorder initialization",
	"plugin initialization",
	"serialization",
	"lost acknowledgement",
] as const) {
	test(`${failure} stops recording while keeping the telemetry session active`, async ({
		page,
	}) => {
		if (failure === "blocked import")
			await page.route("**/replay.*.js", (route) =>
				route.abort("blockedbyclient")
			);
		if (
			failure === "recorder initialization" ||
			failure === "plugin initialization" ||
			failure === "serialization"
		)
			await page.route("**/replay.*.js", (route) =>
				route.fulfill({
					contentType: "text/javascript",
					body: `
						export function getRecordConsolePlugin() {
							if (${JSON.stringify(failure)} === "plugin initialization")
								throw new Error("Plugin setup failed");
							return {};
						}
						export function record({ emit }) {
							if (${JSON.stringify(failure)} === "recorder initialization")
								throw new Error("Recorder setup failed");
							const data = {};
							data.circular = data;
							emit({type: 2, timestamp: Date.now(), data});
							// A dropped event must stop capture before another can be buffered.
							emit({type: 2, timestamp: Date.now(), data: {}});
							return () => { document.body.dataset.recorderStopped = "true"; };
						}
					`,
				})
			);
		const chunks: string[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname.endsWith("/chunk"))
				chunks.push(request.url());
		});
		if (failure === "lost acknowledgement")
			await page.route(
				"**/api/turret/replay-session/*/chunk",
				async (route) => {
					const committed = await route.fetch();
					expect(committed.ok()).toBe(true);
					await route.abort("failed");
				}
			);
		await page.goto("/app/login");
		await page
			.getByLabel("Email", { exact: true })
			.fill("viewer@example.test");
		await page
			.getByLabel("Password", { exact: true })
			.fill("Browser-test-password-123!");

		const blocked = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname.endsWith("/blocked") &&
				response.request().method() === "POST"
		);
		if (failure === "overflow") {
			const uploaded = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname.endsWith("/chunk") &&
					response.request().method() === "POST"
			);
			await page
				.getByRole("button", { name: "Sign in", exact: true })
				.click();
			expect((await uploaded).ok()).toBe(true);
			await page.evaluate((size) => {
				const node = document.createElement("div");
				node.hidden = true;
				node.textContent = "界".repeat(size);
				document.querySelector("body")?.appendChild(node);
			}, REPLAY_CHUNK_TARGET_BYTES);
		} else {
			await page
				.getByRole("button", { name: "Sign in", exact: true })
				.click();
		}
		const response = await blocked;
		expect(response.ok()).toBe(true);
		const reasons = {
			overflow: "replay_payload_limit",
			"blocked import": "rrweb_blocked_by_client",
			"recorder initialization": "rrweb_initialization_failed",
			"plugin initialization": "rrweb_initialization_failed",
			serialization: "replay_serialization_failed",
			"lost acknowledgement": "replay_upload_failed",
		};
		expect(JSON.parse(response.request().postData() ?? "null").reason).toBe(
			reasons[failure]
		);
		if (failure === "serialization")
			await expect(page.locator("body")).toHaveAttribute(
				"data-recorder-stopped",
				"true"
			);
		if (
			failure === "serialization" ||
			failure === "recorder initialization" ||
			failure === "plugin initialization"
		)
			expect(chunks).toEqual([]);
		await expect(
			page.getByText("Turret session: active", { exact: false })
		).toBeVisible();
		if (failure !== "blocked import" && failure !== "lost acknowledgement")
			return;
		const errorResponse = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname.endsWith("/error") &&
				response.request().method() === "POST"
		);
		await page
			.getByRole("button", { name: "Report UI error", exact: true })
			.click();
		expect((await errorResponse).ok()).toBe(true);
		await page
			.getByRole("button", { name: "Feedback", exact: true })
			.click();
		await expect(
			page.getByPlaceholder("What happened? What did you expect?")
		).toHaveAttribute("maxlength", "4000");
		await expect(page.getByPlaceholder("email@domain.com")).toHaveAttribute(
			"maxlength",
			"320"
		);
		await page
			.getByPlaceholder("What happened? What did you expect?")
			.fill("Feedback after the recorder stopped.");
		const feedbackResponse = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname.endsWith("/feedback") &&
				response.request().method() === "POST"
		);
		await page.getByRole("button", { name: "Send", exact: true }).click();
		expect((await feedbackResponse).ok()).toBe(true);
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).not.toBeVisible();
		await page
			.getByRole("button", { name: "Clicked 0 times", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Clicked 1 times", exact: true })
		).toBeVisible();
		await page.getByRole("link", { name: "Login", exact: true }).click();
		await page
			.getByRole("button", { name: "Sign out", exact: true })
			.click();
		await page.getByRole("link", { name: "Home", exact: true }).click();
		await expect(
			page.getByText("Turret session: inactive", { exact: false })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Report UI error", exact: true })
		).toBeDisabled();
	});
}

test("an unauthorized upload ends the session instead of retaining telemetry credentials", async ({
	page,
}) => {
	await page.clock.install();
	await page.route("**/api/turret/replay-session/*/chunk", (route) =>
		route.fulfill({ status: 401, json: { error: "Unauthorized" } })
	);
	const blocked: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.endsWith("/blocked"))
			blocked.push(request.url());
	});
	await page.goto("/app/login");
	await page.getByLabel("Email", { exact: true }).fill("viewer@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("Browser-test-password-123!");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(
		page.getByText("Turret session: active", { exact: false })
	).toBeVisible();
	const rejected = page.waitForResponse((response) =>
		new URL(response.url()).pathname.endsWith("/chunk")
	);
	await page.clock.runFor(2500);
	expect((await rejected).status()).toBe(401);
	await expect(
		page.getByText("Turret session: inactive", { exact: false })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Report UI error", exact: true })
	).toBeDisabled();
	await page.getByRole("button", { name: "Feedback", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Send", exact: true })
	).toBeDisabled();
	expect(blocked).toEqual([]);
});

test("the server-issued deadline ends capture and disables session-linked telemetry", async ({
	page,
}) => {
	await page.clock.install();
	await page.goto("/app/login");
	await page.getByLabel("Email", { exact: true }).fill("viewer@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("Browser-test-password-123!");
	const initialized = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname ===
			"/api/turret/replay-session/init"
	);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	const lease = await (await initialized).json();
	await expect(
		page.getByText("Turret session: active", { exact: false })
	).toBeVisible();
	await page.waitForResponse((response) =>
		new URL(response.url()).pathname.endsWith("/chunk")
	);
	const writes: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			new URL(request.url()).pathname.startsWith("/api/turret/")
		)
			writes.push(request.url());
	});
	const now = await page.evaluate(() => Date.now());
	await page.clock.fastForward(
		Math.max(1, lease.upload_expires_at - now + 1)
	);
	await expect(
		page.getByText("Turret session: inactive", { exact: false })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Report UI error", exact: true })
	).toBeDisabled();
	await page.getByRole("button", { name: "Feedback", exact: true }).click();
	await expect(
		page.getByText("A Turret session is not active.", { exact: false })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Send", exact: true })
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: "Clicked 0 times", exact: true })
		.click();
	await page.clock.runFor(5000);
	expect(writes).toEqual([]);
});

test("login returns to its destination and Turret links use destination search defaults", async ({
	page,
}) => {
	await page.goto("/app/ts_admin/turret/settings");
	await expect(page).toHaveURL(/\/app\/login/);
	await page.getByLabel("Email", { exact: true }).fill("admin@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("Browser-test-password-123!");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Turret settings", exact: true })
	).toBeVisible();
	const replay = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname ===
			"/api/internal/turret/replay-sessions"
	);
	await page
		.getByRole("button", { name: "Replay sessions", exact: true })
		.click();
	const replayResponse = await replay;
	expect(replayResponse.ok()).toBe(true);
	const replayQuery = new URL(replayResponse.url()).searchParams;
	expect(
		Number(replayQuery.get("to")) - Number(replayQuery.get("from"))
	).toBe(60 * 60_000);
	expect(replayQuery.get("limit")).toBe("50");
	const filtered = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return (
			url.pathname === "/api/internal/turret/replay-sessions" &&
			Number(url.searchParams.get("to")) -
				Number(url.searchParams.get("from")) ===
				15 * 60_000
		);
	});
	await page.getByRole("button", { name: "Last 15m", exact: true }).click();
	expect((await filtered).ok()).toBe(true);
	const issues = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/internal/turret/issues"
	);
	await page.getByRole("button", { name: "Issues", exact: true }).click();
	const issuesResponse = await issues;
	expect(issuesResponse.ok()).toBe(true);
	const issueQuery = new URL(issuesResponse.url()).searchParams;
	expect(issueQuery.get("status")).toBe("open");
	expect(Number(issueQuery.get("to")) - Number(issueQuery.get("from"))).toBe(
		24 * 60 * 60_000
	);
	await expect(
		page.getByRole("button", { name: "Last 30d", exact: true })
	).toBeVisible();
});

test("each editable policy field drives saving without overwriting other settings", async ({
	page,
}) => {
	await page.goto("/app/login");
	await page.getByLabel("Email", { exact: true }).fill("admin@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("Browser-test-password-123!");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).not.toHaveURL(/\/app\/login/);
	const endpoint = "/api/internal/turret/compliance";
	const originalResponse = await page.request.get(endpoint);
	expect(originalResponse.ok()).toBe(true);
	const original = turretComplianceSchema.parse(
		(await originalResponse.json()).policy
	);
	const untouched = {
		level: ["error"] as const,
		lengthThreshold: 17,
		stringifyOptions: {
			stringLengthLimit: 123,
			numOfKeysLimit: 9,
			depthOfLimit: 3,
		},
	};
	try {
		const seeded = await page.request.put(endpoint, {
			data: { console: untouched },
		});
		expect(seeded.ok()).toBe(true);
		await page.goto("/app/ts_admin/turret/settings");
		const retention = page.getByLabel("Retention days", { exact: true });
		const mask = page.getByRole("switch", {
			name: "Mask all inputs",
			exact: true,
		});
		const consoleCapture = page.getByRole("switch", {
			name: "Console capture",
			exact: true,
		});
		const save = page.getByRole("button", {
			name: "Save policy",
			exact: true,
		});
		await expect(retention).toHaveValue(String(original.retentionDays));
		await expect(save).toBeDisabled();
		let expected = {
			retentionDays: original.retentionDays,
			rrweb: { maskAllInputs: original.rrweb.maskAllInputs },
			console: { enabled: original.console.enabled },
		};
		const edits = [
			async () =>
				retention.fill(
					String(
						original.retentionDays === 365
							? 364
							: original.retentionDays + 1
					)
				),
			async () => mask.click(),
			async () => consoleCapture.click(),
		];
		for (const edit of edits) {
			await edit();
			await expect(save).toBeEnabled();
			expected = {
				retentionDays: Number(await retention.inputValue()),
				rrweb: { maskAllInputs: await mask.isChecked() },
				console: { enabled: await consoleCapture.isChecked() },
			};
			const written = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === endpoint &&
					response.request().method() === "PUT"
			);
			await save.click();
			const response = await written;
			expect(response.ok()).toBe(true);
			expect(response.request().postDataJSON()).toEqual(expected);
			await expect(save).toBeDisabled();
			const policy = turretComplianceSchema.parse(
				(await response.json()).policy
			);
			expect(policy.console).toMatchObject(untouched);
		}
		await page.reload();
		await expect(retention).toHaveValue(String(expected.retentionDays));
		await expect(mask).toBeChecked({
			checked: expected.rrweb.maskAllInputs,
		});
		await expect(consoleCapture).toBeChecked({
			checked: expected.console.enabled,
		});
		await expect(save).toBeDisabled();
	} finally {
		const { version: _version, ...restore } = original;
		const restored = await page.request.put(endpoint, { data: restore });
		expect(restored.ok()).toBe(true);
	}
});
