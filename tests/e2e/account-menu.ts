import { expect, type Page } from "@playwright/test";

// How long to keep retrying a menu choice while the header settles.
const MENU_CHOICE_TIMEOUT_MS = 15_000;
const MENU_ITEM_CLICK_TIMEOUT_MS = 2_000;

function trigger(page: Page) {
	return page
		.getByRole("banner")
		.getByRole("button", { name: /^Account menu for / });
}

// Sign out, Account and Admin live in the header's account menu. After
// sign-in the root clears its caches and reloads the routes for the new
// account, which can remount the header and close a menu opened just before;
// so open it (again, if a remount closed it) until the item can be clicked.
export async function chooseFromAccountMenu(page: Page, name: string) {
	const item = page.getByRole("menuitem", { name, exact: true });
	await expect(async () => {
		if (!(await item.isVisible())) await trigger(page).click();
		await item.click({ timeout: MENU_ITEM_CLICK_TIMEOUT_MS });
	}).toPass({ timeout: MENU_CHOICE_TIMEOUT_MS });
}

// Leaves the menu open, for asserting what it offers.
export async function openAccountMenu(page: Page) {
	const account = page.getByRole("menuitem", {
		name: "Account",
		exact: true,
	});
	await expect(async () => {
		if (!(await account.isVisible())) await trigger(page).click();
		await expect(account).toBeVisible({
			timeout: MENU_ITEM_CLICK_TIMEOUT_MS,
		});
	}).toPass({ timeout: MENU_CHOICE_TIMEOUT_MS });
}

export async function signOut(page: Page) {
	await chooseFromAccountMenu(page, "Sign out");
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true })
	).toBeVisible();
}
