import { expect, test, type Page } from "@playwright/test";
import {
	FIXTURE_PASSWORD,
	FIXTURE_PERSONAS,
	fixtureEmail,
	type FixturePersona,
} from "../../scripts/testing/personas.ts";
import { appName, navItemsFor } from "../../src/react-app/components/nav-items";
import { chooseFromAccountMenu, openAccountMenu } from "./account-menu";

const WIDTHS_PX = [320, 390, 768, 1024, 1440];

async function signIn(page: Page, persona: FixturePersona) {
	await page.goto("/app/login");
	await page.getByLabel("Email", { exact: true }).fill(fixtureEmail(persona));
	await page.getByLabel("Password", { exact: true }).fill(FIXTURE_PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(
		page
			.getByRole("banner")
			.getByRole("button", { name: /^Account menu for / })
	).toBeVisible();
}

// Links and buttons of the visible header that are not fully on screen. This
// is how the old header failed: areas ran off its edge at every width.
async function clippedInHeader(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const header = document.querySelector("header");
		if (!header) return ["(no header)"];
		return [...header.querySelectorAll("a, button")]
			.filter((element) => element.getClientRects().length > 0)
			.filter((element) => {
				const rect = element.getBoundingClientRect();
				return rect.left < -1 || rect.right > window.innerWidth + 1;
			})
			.map(
				(element) =>
					element.textContent?.trim() ||
					element.getAttribute("aria-label") ||
					element.tagName
			);
	});
}

async function expectNothingClipped(page: Page, path: string) {
	for (const width of WIDTHS_PX) {
		await page.setViewportSize({ width, height: 800 });
		await page.goto(path);
		await expect(page.getByRole("banner")).toBeVisible();
		expect(await clippedInHeader(page), `${path} at ${width}px`).toEqual(
			[]
		);
	}
}

for (const persona of FIXTURE_PERSONAS)
	test(`${persona} sees every area and the account menu at every width`, async ({
		page,
	}) => {
		await signIn(page, persona);
		await expectNothingClipped(page, "/app/organizations");
		const tabs = page.getByRole("navigation", { name: "Main" });
		for (const { label } of navItemsFor(true))
			await expect(
				tabs.getByRole("link", { name: label, exact: true })
			).toBeVisible();
	});

test("signed out, the header offers public areas and Sign in", async ({
	page,
}) => {
	await expectNothingClipped(page, "/app/status");
	const header = page.getByRole("banner");
	await expect(
		header.getByRole("link", { name: "Sign in", exact: true })
	).toBeVisible();
	const tabs = header.getByRole("navigation", { name: "Main" });
	const offered = navItemsFor(false);
	for (const { label } of offered)
		await expect(
			tabs.getByRole("link", { name: label, exact: true })
		).toBeVisible();
	for (const { label } of navItemsFor(true))
		if (!offered.some((item) => item.label === label))
			await expect(
				tabs.getByRole("link", { name: label, exact: true })
			).toHaveCount(0);
	await expect(
		header.getByRole("button", { name: /^Account menu for / })
	).toHaveCount(0);
});

test("the header is one row from laptop width", async ({ page }) => {
	await page.setViewportSize({ width: 1024, height: 800 });
	await signIn(page, "owner");
	const header = page.getByRole("banner");
	const lastArea = navItemsFor(true).at(-1)?.label ?? "";
	const middles = await Promise.all(
		[
			header.getByRole("link", { name: appName, exact: true }),
			header.getByRole("link", { name: lastArea, exact: true }),
			header.getByRole("button", { name: /^Account menu for / }),
		].map(async (part) => {
			const box = await part.boundingBox();
			if (!box) throw new Error("A header part is not rendered.");
			return box.y + box.height / 2;
		})
	);
	const [brand = 0, ...rest] = middles;
	for (const middle of rest) expect(Math.abs(middle - brand)).toBeLessThan(4);
});

test("only administrators get the admin area, and can get back", async ({
	browser,
}) => {
	const member = await (await browser.newContext()).newPage();
	await signIn(member, "owner");
	await openAccountMenu(member);
	await expect(
		member.getByRole("menuitem", { name: "Sign out", exact: true })
	).toBeVisible();
	await expect(
		member.getByRole("menuitem", { name: "Admin", exact: true })
	).toHaveCount(0);
	await member.context().close();

	const admin = await (await browser.newContext()).newPage();
	await signIn(admin, "admin");
	await chooseFromAccountMenu(admin, "Admin");
	await expect(admin).toHaveURL(/\/app\/ts_admin$/);
	await admin
		.getByRole("navigation", { name: "Admin" })
		.getByRole("link", { name: "Users", exact: true })
		.click();
	await expect(admin).toHaveURL(/\/app\/ts_admin\/users/);
	// The admin header keeps the way back, its tabs and the menu on a phone.
	await admin.setViewportSize({ width: 320, height: 800 });
	expect(await clippedInHeader(admin)).toEqual([]);
	await admin
		.getByRole("banner")
		.getByRole("link", { name: "App", exact: true })
		.click();
	await expect(admin).toHaveURL(/\/app\/?$/);
	await admin.context().close();
});
