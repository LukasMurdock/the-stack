import { expect, type Page } from "@playwright/test";

// Sign out, Account, Admin and API docs live in the header's account menu.
// The root draws the header once, so it is not remounted after sign-in and an
// open menu stays open.
function trigger(page: Page) {
	return page
		.getByRole("banner")
		.getByRole("button", { name: /^Account menu for / });
}

// Leaves the menu open, for asserting what it offers.
export async function openAccountMenu(page: Page) {
	await trigger(page).click();
}

export async function chooseFromAccountMenu(page: Page, name: string) {
	await openAccountMenu(page);
	await page.getByRole("menuitem", { name, exact: true }).click();
}

export async function signOut(page: Page) {
	await chooseFromAccountMenu(page, "Sign out");
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true })
	).toBeVisible();
}
