import { expect, test, type Page } from "@playwright/test";
import { hc } from "hono/client";
import { z } from "zod";
import type { ApiType } from "../../src/worker/api";
import { jsonOrThrow } from "../../src/react-app/api";

async function playbackFixture(page: Page, baseURL: string | undefined) {
	if (!baseURL) throw new Error("Worker URL is required.");
	const signedIn = await page.request.post("/api/auth/sign-in/email", {
		headers: { Origin: baseURL },
		data: {
			email: "admin@example.test",
			password: "Browser-test-password-123!",
		},
	});
	expect(signedIn.ok()).toBe(true);
	const { token } = z
		.object({ token: z.string() })
		.parse(await signedIn.json());
	const client = hc<ApiType>(`${baseURL}/api`, {
		headers: { Origin: baseURL, authorization: `Bearer ${token}` },
	});
	const initialized = await jsonOrThrow(
		await client.turret["replay-session"].init.$post({ json: {} })
	);
	const upload = hc<ApiType>(`${baseURL}/api`, {
		headers: { Origin: baseURL },
	});
	const session = upload.turret["replay-session"][":id"];
	const param = { id: initialized.session_id };
	const header = { authorization: `Bearer ${initialized.upload_token}` };
	await jsonOrThrow(
		await session.error.$post({
			param,
			header,
			json: { ts: 1100, message: "Playback error fixture" },
		})
	);
	await jsonOrThrow(
		await session.feedback.$post({
			param,
			header,
			json: {
				ts: 1100,
				kind: "bug",
				message: "Playback feedback fixture",
			},
		})
	);
	const readPath = `/api/internal/turret/replay-session/${initialized.session_id}`;
	await page.route(`**${readPath}/chunks`, (route) =>
		route.fulfill({ json: { chunks: [{ seq: 0 }] } })
	);
	return {
		readPath,
		path: `/app/ts_admin/turret/replay-sessions/${initialized.session_id}`,
	};
}

const events = [
	{ type: 2, timestamp: 1000, data: { node: {} } },
	{
		type: 6,
		timestamp: 1100,
		data: {
			plugin: "rrweb/console@1",
			payload: {
				level: "error",
				payload: ['"Playback console fixture"'],
				trace: [],
			},
		},
	},
];
const chunk = { seq: 0, events, ts_start: 1000, ts_end: 1100 };

function playerModule(throws = false) {
	return `export default class Player {
		constructor({target}) {
			this.target = target;
			target.textContent = "Mounted playback fixture";
			if (${throws}) throw new Error("Player construction failed");
		}
		getMetaData() { return { startTime: 1000, totalTime: 1000 }; }
		goto(offset) { this.target.dataset.offset = String(offset); }
		$destroy() {
			document.body.dataset.playerDestroyed = String(Number(document.body.dataset.playerDestroyed ?? 0) + 1);
		}
	}`;
}

for (const failure of ["library", "construction"] as const) {
	test(`${failure} failure leaves replay controls disabled and clears partial mounting`, async ({
		page,
		baseURL,
	}) => {
		const fixture = await playbackFixture(page, baseURL);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/rrweb-player.*.js", (route) =>
			failure === "library"
				? route.abort("blockedbyclient")
				: route.fulfill({
						contentType: "text/javascript",
						body: playerModule(failure === "construction"),
					})
		);
		await page.route(`**${fixture.readPath}/chunk/0`, (route) =>
			route.fulfill({ json: chunk })
		);
		await page.goto(fixture.path);
		await expect(
			page.getByText("Failed to load replay:", { exact: false })
		).toBeVisible();
		await expect(
			page.getByText("Mounted playback fixture", { exact: true })
		).not.toBeVisible();
		if (failure === "construction")
			await expect(
				page.getByText(
					"Failed to load replay: Player construction failed",
					{ exact: true }
				)
			).toBeVisible();
		for (const tab of ["Errors", "Feedback"] as const) {
			await page.getByRole("tab", { name: tab, exact: true }).click();
			await expect(
				page
					.getByRole("tabpanel", { name: tab, exact: true })
					.getByRole("button", { name: "Jump", exact: true })
			).toBeDisabled();
		}
		await page.getByRole("tab", { name: "Console", exact: true }).click();
		await expect(
			page.getByText("Load the replay to view console output.", {
				exact: true,
			})
		).toBeVisible();
		expect(errors).toEqual([]);
	});
}

test("jump controls wait for mounting, seek consistently and clean up on navigation", async ({
	page,
	baseURL,
}) => {
	const fixture = await playbackFixture(page, baseURL);
	const requested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await page.route("**/rrweb-player.*.js", (route) =>
		route.fulfill({ contentType: "text/javascript", body: playerModule() })
	);
	await page.route(`**${fixture.readPath}/chunk/0`, async (route) => {
		requested.resolve();
		await release.promise;
		await route.fulfill({ json: chunk });
	});
	await page.goto(fixture.path);
	await requested.promise;
	await expect(
		page.getByText("Loading replay… 0/1", { exact: true })
	).toBeVisible();
	for (const tab of ["Errors", "Feedback"] as const) {
		await page.getByRole("tab", { name: tab, exact: true }).click();
		await expect(
			page
				.getByRole("tabpanel", { name: tab, exact: true })
				.getByRole("button", { name: "Jump", exact: true })
		).toBeDisabled();
	}
	release.resolve();
	await expect(
		page.getByText("Loaded 2 events", { exact: true })
	).toBeVisible();
	const player = page.getByText("Mounted playback fixture", { exact: true });
	for (const tab of ["Errors", "Feedback", "Console"] as const) {
		await page.getByRole("tab", { name: tab, exact: true }).click();
		const jump = page
			.getByRole("tabpanel", { name: tab, exact: true })
			.getByRole("button", { name: "Jump", exact: true });
		await expect(jump).toBeEnabled();
		await jump.click();
		await expect(player).toHaveAttribute("data-offset", "100");
	}
	await page
		.getByRole("button", { name: "Replay sessions", exact: true })
		.click();
	await expect(page).toHaveURL(
		/\/app\/ts_admin\/turret\/replay-sessions(?:\?|$)/
	);
	await expect(page.locator("body")).toHaveAttribute(
		"data-player-destroyed",
		"1"
	);
});

test("leaving a pending replay aborts its chunks and cannot mount a late player", async ({
	page,
	baseURL,
}) => {
	const fixture = await playbackFixture(page, baseURL);
	const requested = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const handled = Promise.withResolvers<void>();
	await page.route("**/rrweb-player.*.js", (route) =>
		route.fulfill({ contentType: "text/javascript", body: playerModule() })
	);
	await page.route(`**${fixture.readPath}/chunk/0`, async (route) => {
		requested.resolve();
		await release.promise;
		try {
			await route.fulfill({ json: chunk });
		} finally {
			handled.resolve();
		}
	});
	await page.goto(fixture.path);
	await requested.promise;
	const aborted = page.waitForEvent(
		"requestfailed",
		(request) =>
			new URL(request.url()).pathname === `${fixture.readPath}/chunk/0`
	);
	await page
		.getByRole("button", { name: "Replay sessions", exact: true })
		.click();
	expect((await aborted).failure()?.errorText).toBe("net::ERR_ABORTED");
	release.resolve();
	await handled.promise;
	await expect(
		page.getByText("Mounted playback fixture", { exact: true })
	).not.toBeVisible();
	await expect(page.locator("body")).not.toHaveAttribute(
		"data-player-destroyed"
	);
});
