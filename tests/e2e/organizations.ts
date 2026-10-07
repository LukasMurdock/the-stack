import { expect, type Page, type BrowserContext } from "@playwright/test";

async function signIn(page: Page, id: "owner" | "viewer") {
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true })
	).toBeVisible();
	await page.getByLabel("Email", { exact: true }).fill(`${id}@example.test`);
	await page
		.getByLabel("Password", { exact: true })
		.fill("Browser-test-password-123!");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).not.toHaveURL(/\/app\/login/);
}

export async function createOrganization(page: Page) {
	await page.goto("/app/organizations");
	await signIn(page, "owner");
	const name = `Studio ${crypto.randomUUID()}`;
	await page.getByLabel("Organization name").fill(name);
	await page.getByRole("button", { name: "Create organization" }).click();
	await expect(page.getByRole("status")).toHaveText("Organization created.");
	await page.getByRole("link", { name, exact: true }).click();
	return name;
}

export async function createProject(page: Page) {
	await page.getByRole("link", { name: "Projects", exact: true }).click();
	await page.getByLabel("Project name").fill("Launch pilot");
	await page.getByLabel("Description").fill("Plan the pilot.");
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Launch pilot", exact: true })
	).toBeVisible();
}

export async function joinedViewer(owner: Page, context: BrowserContext) {
	const name = await createOrganization(owner);
	await createProject(owner);
	await owner.getByRole("link", { name: "Members", exact: true }).click();
	await owner.getByLabel("Email address").fill("viewer@example.test");
	await owner.getByRole("button", { name: "Create invitation" }).click();
	await expect(owner.getByLabel("Invitation link")).toBeVisible();
	const viewer = await context.newPage();
	await viewer.goto(await owner.getByLabel("Invitation link").inputValue());
	await viewer.getByRole("link", { name: "Sign in", exact: true }).click();
	await signIn(viewer, "viewer");
	await viewer.getByRole("button", { name: "Accept invitation" }).click();
	await expect(viewer.getByRole("status")).toHaveText(`You joined ${name}.`);
	await viewer.getByRole("link", { name: "Open organization" }).click();
	await viewer.getByRole("link", { name: "Projects", exact: true }).click();
	await expect(
		viewer.getByRole("heading", { name: "Launch pilot", exact: true })
	).toBeVisible();
	return viewer;
}
