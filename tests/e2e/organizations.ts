import { expect, type Page, type BrowserContext } from "@playwright/test";
import {
	organizationResponseSchema,
	invitationResponseSchema,
} from "../../src/contracts/organizations";
import { projectResponseSchema } from "../../src/features/projects/contracts";

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

// Session and member tests need an existing organization, not another onboarding walkthrough.
// Set up through real HTTP boundaries; invitation and project tests retain their UI workflows.
export async function joinedViewer(
	owner: Page,
	context: BrowserContext,
	baseURL: string | undefined
) {
	if (!baseURL) throw new Error("The Worker URL is required.");
	for (const [client, id] of [
		[owner.request, "owner"],
		[context.request, "viewer"],
	] as const) {
		const signedIn = await client.post(
			new URL("/api/auth/sign-in/email", baseURL).toString(),
			{
				headers: { Origin: baseURL },
				data: {
					email: `${id}@example.test`,
					password: "Browser-test-password-123!",
				},
			}
		);
		expect(signedIn.ok()).toBe(true);
	}
	const created = await owner.request.post("/api/organizations", {
		data: { name: `Studio ${crypto.randomUUID()}` },
	});
	expect(created.ok()).toBe(true);
	const { organization } = organizationResponseSchema.parse(
		await created.json()
	);
	const path = `/api/organizations/${organization.id}`;
	const project = await owner.request.post(`${path}/projects`, {
		data: { name: "Launch pilot", description: "Plan the pilot." },
	});
	expect(project.ok()).toBe(true);
	projectResponseSchema.parse(await project.json());
	const invited = await owner.request.post(`${path}/invitations`, {
		data: { email: "viewer@example.test", role: "viewer" },
	});
	expect(invited.ok()).toBe(true);
	const { invitation } = invitationResponseSchema.parse(await invited.json());
	const accepted = await context.request.post(
		new URL("/api/invitations/accept", baseURL).toString(),
		{
			data: { token: invitation.token },
		}
	);
	expect(accepted.ok()).toBe(true);
	organizationResponseSchema.parse(await accepted.json());
	await owner.goto(`/app/organizations/${organization.id}/members`);
	const viewer = await context.newPage();
	await viewer.goto(
		new URL(
			`/app/organizations/${organization.id}/projects`,
			baseURL
		).toString()
	);
	await expect(
		viewer.getByRole("heading", { name: "Launch pilot", exact: true })
	).toBeVisible();
	return viewer;
}
