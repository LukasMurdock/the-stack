import { expect, type Page, type BrowserContext } from "@playwright/test";
import {
	organizationResponseSchema,
	invitationResponseSchema,
} from "../../src/contracts/organizations";

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
	await page.getByRole("button", { name: "New organization" }).click();
	await page.getByLabel("Organization name").fill(name);
	await page.getByRole("button", { name: "Create organization" }).click();
	// Creating one opens it.
	await expect(
		page.getByRole("heading", { level: 1, name, exact: true })
	).toBeVisible();
	return name;
}

// The signed-in access line in the organization header ("Viewer access"): a
// role probe that depends only on core organization screens.
export function roleLabel(page: Page, role: "owner" | "editor" | "viewer") {
	const label = `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
	return page.getByText(`${label} access`, { exact: true });
}

// Two organizations owned by the same user, the first opened in the UI.
export async function twoOrganizations(page: Page) {
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
export async function openFirst(page: Page, firstName: string) {
	await page
		.getByRole("link", { name: "All organizations", exact: true })
		.click();
	await page.getByRole("link", { name: firstName, exact: true }).click();
	await page.evaluate(() => {
		document.body.dataset.scopeNavigation = "same-document";
	});
}

// Session and member tests need an existing organization, not another onboarding walkthrough.
// Set up through real HTTP boundaries; invitation tests retain their UI workflow.
// Returns the viewer's page, open on the organization's members screen.
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
			`/app/organizations/${organization.id}/members`,
			baseURL
		).toString()
	);
	await expect(
		viewer.getByRole("heading", { name: "Members", exact: true })
	).toBeVisible();
	await expect(roleLabel(viewer, "viewer")).toBeVisible();
	return { viewer, organizationId: organization.id };
}
