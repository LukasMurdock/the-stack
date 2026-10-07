import { expect, test } from "@playwright/test";
import { z } from "zod";
import { createOrganization } from "./organizations";

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
