import { expect, test } from "@playwright/test";
import { openFirst, twoOrganizations } from "./organizations";
import { PAGE_SIZE } from "../../src/contracts/pagination";

test("changing organization discards invitation results, drafts and pagination", async ({
	page,
}) => {
	const fixture = await twoOrganizations(page);
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
	// The UI invitation plus PAGE_SIZE from setup make one more than a page;
	// the single member fits on one, so this is the only pager.
	const pagination = page.getByRole("navigation", {
		name: "Pagination",
		exact: true,
	});
	await pagination.getByRole("button", { name: "Next", exact: true }).click();
	await expect(
		pagination.getByText(
			`${PAGE_SIZE + 1}–${PAGE_SIZE + 1} of ${PAGE_SIZE + 1}`,
			{
				exact: true,
			}
		)
	).toBeVisible();
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
	await expect(pagination).toHaveCount(0);
});
