import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { flagsResponseSchema } from "../../src/contracts/feature-flags";
import { PAGE_SIZE } from "../../src/contracts/pagination";
import { projectResponseSchema } from "../../src/features/projects/contracts";
import {
	createOrganization,
	joinedViewer,
	openFirst,
	twoOrganizations,
} from "./organizations";

// The removable example's browser tests. Core organization, member and
// session specs must not depend on anything here.

test("project creation preserves the draft after failure and persists after retry", async ({
	page,
}) => {
	// Outcome events this browser sends while creating the project.
	const outcomes: Array<{
		attemptId: string;
		event: string;
		reason?: string;
	}> = [];
	page.on("request", (request) => {
		if (!request.url().endsWith("/outcome")) return;
		outcomes.push(
			z
				.object({
					attemptId: z.string(),
					workflow: z.literal("project.create"),
					event: z.string(),
					reason: z.string().optional(),
				})
				.parse(request.postDataJSON())
		);
	});
	await createOrganization(page);
	await page.getByRole("link", { name: "Projects", exact: true }).click();
	await page.getByLabel("Project name").fill("Launch");
	await page.getByLabel("Description").fill("Plan the pilot.");
	await page.route("**/api/organizations/*/projects", (route) =>
		route.request().method() === "POST"
			? route.fulfill({
					status: 503,
					contentType: "text/plain",
					body: "Unavailable",
				})
			: route.continue()
	);
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("503");
	await expect(page.getByLabel("Project name")).toHaveValue("Launch");
	await page.unroute("**/api/organizations/*/projects");
	await page.getByLabel("Project name").fill("Launch pilot");
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Launch pilot", exact: true })
	).toBeVisible();
	// The failed submission and the retry are one attempt that succeeded
	// after a failure, not a failed attempt.
	await expect
		.poll(() => outcomes.map(({ event, reason }) => [event, reason]))
		.toEqual([
			["started", undefined],
			["failed", "http_503"],
			["succeeded", undefined],
		]);
	expect(new Set(outcomes.map(({ attemptId }) => attemptId)).size).toBe(1);
	await page.reload();
	await expect(
		page.getByText("Plan the pilot.", { exact: true })
	).toBeVisible();
});

test("viewers read projects without the create form", async ({
	page,
	browser,
	baseURL,
}) => {
	const context = await browser.newContext();
	try {
		const { viewer, organizationId } = await joinedViewer(
			page,
			context,
			baseURL
		);
		const projectsPath = `/api/organizations/${organizationId}/projects`;
		const created = await page.request.post(projectsPath, {
			data: { name: "Launch pilot", description: "Plan the pilot." },
		});
		expect(created.ok()).toBe(true);
		projectResponseSchema.parse(await created.json());
		await viewer
			.getByRole("link", { name: "Projects", exact: true })
			.click();
		await expect(
			viewer.getByRole("heading", { name: "Launch pilot", exact: true })
		).toBeVisible();
		await expect(
			viewer.getByRole("button", { name: "Create project", exact: true })
		).toHaveCount(0);
		const denied = await context.request.post(projectsPath, {
			data: { name: "No", description: "" },
		});
		expect(denied.status()).toBe(403);
	} finally {
		await context.close();
	}
});

test("changing organization resets project pagination, drafts and failed mutation state", async ({
	page,
}) => {
	const fixture = await twoOrganizations(page);
	for (let i = 0; i <= PAGE_SIZE; i++) {
		const response = await page.request.post(
			`/api/organizations/${fixture.firstId}/projects`,
			{
				data: { name: `Project ${i}`, description: "" },
			}
		);
		expect(response.ok()).toBe(true);
	}
	await page.goto(`${fixture.secondPath}/projects/`);
	await expect(
		page.getByRole("heading", { name: "Projects", exact: true })
	).toBeVisible();
	await openFirst(page, fixture.firstName);
	await page.getByRole("link", { name: "Projects", exact: true }).click();
	const projects = page.locator("section").filter({
		has: page.getByRole("heading", { name: "Projects", exact: true }),
	});
	await expect(
		projects.getByText(`1–${PAGE_SIZE} of ${PAGE_SIZE + 1}`, {
			exact: true,
		})
	).toBeVisible();
	await projects.getByRole("button", { name: "Next", exact: true }).click();
	const lastPage = `${PAGE_SIZE + 1}–${PAGE_SIZE + 1} of ${PAGE_SIZE + 1}`;
	await expect(projects.getByText(lastPage, { exact: true })).toBeVisible();
	await expect(
		projects.getByRole("button", { name: "Next", exact: true })
	).toBeDisabled();
	await page.getByLabel("Project name").fill("First organization's draft");
	await page
		.getByLabel("Description")
		.fill("Keep this work in the first organization.");
	await page.route(
		`**/api/organizations/${fixture.firstId}/projects`,
		(route) =>
			route.request().method() === "POST"
				? route.fulfill({ status: 503, body: "Unavailable" })
				: route.continue()
	);
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("503");
	// History entries: second/projects -> list -> first/members -> first/projects.
	await page.evaluate(() => window.history.go(-3));
	await expect(page).toHaveURL(`${fixture.secondPath}/projects/`);
	await expect(
		page.getByText(fixture.secondName, { exact: true })
	).toBeVisible();
	await expect(page.locator("body")).toHaveAttribute(
		"data-scope-navigation",
		"same-document"
	);
	// The second organization has no projects: a reset page shows no pager.
	await expect(
		page.getByRole("navigation", { name: "Pagination", exact: true })
	).toHaveCount(0);
	await expect(page.getByLabel("Project name")).toHaveValue("");
	await expect(page.getByLabel("Description")).toHaveValue("");
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the project count ships dark until projects-total is on for the organization", async ({
	page,
}) => {
	const name = await createOrganization(page);
	const organizationId = /\/organizations\/([^/]+)/.exec(
		new URL(page.url()).pathname
	)?.[1];
	if (organizationId === undefined)
		throw new Error("Organization ID is required.");
	const count = page.getByText(`0 projects in ${name}`, { exact: true });
	const flagsServed = page.waitForResponse((response) =>
		response.url().includes("/api/flags?")
	);
	await page.getByRole("link", { name: "Projects", exact: true }).click();
	// The store starts at the registry default, so the Worker serves off.
	const served = flagsResponseSchema.parse(await (await flagsServed).json());
	expect(served.flags["projects-total"]).toBe(false);
	await expect(
		page.getByRole("heading", { name: "Projects", exact: true })
	).toBeVisible();
	await expect(count).toHaveCount(0);
	// The same command a developer runs, against this run's local store.
	execFileSync(
		process.execPath,
		[
			"scripts/flags.ts",
			"on",
			"projects-total",
			"--organization",
			organizationId,
			"--e2e",
		],
		{ env: process.env, stdio: "pipe" }
	);
	await page.reload();
	await expect(count).toBeVisible();
});
