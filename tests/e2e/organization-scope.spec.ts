import { expect, test, type Page } from "@playwright/test";
import { createOrganization } from "./organizations";
import { organizationResponseSchema } from "../../src/contracts/organizations";
import { PAGE_SIZE } from "../../src/contracts/pagination";

async function organizations(page: Page) {
	const firstName = await createOrganization(page);
	const firstPath = new URL(page.url()).pathname;
	const firstId = firstPath.split("/").at(-2);
	if (!firstId) throw new Error("Organization ID is required.");
	const secondName = `Studio ${crypto.randomUUID()}`;
	const response = await page.request.post("/api/organizations", {
		data: { name: secondName },
	});
	expect(response.ok()).toBe(true);
	const { organization: second } = organizationResponseSchema.parse(
		await response.json()
	);
	return {
		firstId,
		firstName,
		secondName,
		secondPath: `/app/organizations/${second.id}`,
	};
}

// Back skips the list page entirely, changing only the organization parameter
// of the currently mounted route. A full navigation would hide the regression.
async function openFirst(page: Page, firstName: string) {
	await page
		.getByRole("link", { name: "All organizations", exact: true })
		.click();
	await page.getByRole("link", { name: firstName, exact: true }).click();
	await page.evaluate(() => {
		document.body.dataset.scopeNavigation = "same-document";
	});
}

test("changing organization resets project pagination, drafts and failed mutation state", async ({
	page,
}) => {
	const fixture = await organizations(page);
	for (let i = 0; i < PAGE_SIZE; i++) {
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
	await projects.getByRole("button", { name: "Next", exact: true }).click();
	await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
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
	await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
	await expect(page.getByLabel("Project name")).toHaveValue("");
	await expect(page.getByLabel("Description")).toHaveValue("");
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("changing organization discards invitation results, drafts and pagination", async ({
	page,
}) => {
	const fixture = await organizations(page);
	for (let i = 0; i < PAGE_SIZE; i++) {
		const response = await page.request.post(
			`/api/organizations/${fixture.firstId}/invitations`,
			{
				data: { email: `invite-${i}@example.test`, role: "viewer" },
			}
		);
		expect(response.ok()).toBe(true);
	}
	await page.goto(`${fixture.secondPath}/members`);
	await expect(
		page.getByRole("heading", { name: "Members", exact: true })
	).toBeVisible();
	await openFirst(page, fixture.firstName);
	await page.getByLabel("Email address").fill("result@example.test");
	await page
		.getByRole("button", { name: "Create invitation", exact: true })
		.click();
	await expect(page.getByLabel("Invitation link")).toBeVisible();
	await page.getByLabel("Email address").fill("draft@example.test");
	await page.getByLabel("Access", { exact: true }).selectOption("editor");
	const pagination = page
		.getByRole("navigation", { name: "Pagination", exact: true })
		.nth(1);
	await pagination.getByRole("button", { name: "Next", exact: true }).click();
	await expect(pagination.getByText("Page 2", { exact: true })).toBeVisible();
	// History entries: second/members -> list -> first/members.
	await page.evaluate(() => window.history.go(-2));
	await expect(page).toHaveURL(`${fixture.secondPath}/members`);
	await expect(
		page.getByText(fixture.secondName, { exact: true })
	).toBeVisible();
	await expect(page.locator("body")).toHaveAttribute(
		"data-scope-navigation",
		"same-document"
	);
	await expect(page.getByLabel("Invitation link")).toHaveCount(0);
	await expect(page.getByLabel("Email address")).toHaveValue("");
	await expect(page.getByLabel("Access", { exact: true })).toHaveValue(
		"viewer"
	);
	await expect(pagination.getByText("Page 1", { exact: true })).toBeVisible();
});
