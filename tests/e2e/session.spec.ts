import { expect, test } from "@playwright/test";
import { joinedViewer } from "./organizations";

test("account replacement refreshes private permissions in both directions", async ({
	page,
	browser,
}) => {
	const viewerContext = await browser.newContext();
	try {
		const viewer = await joinedViewer(page, viewerContext);
		// Replace the account without an intervening signed-out state. Focus refetch
		// must replace both route identity and cached role, then reverse cleanly.
		const otherTab = await viewerContext.newPage();
		await otherTab.goto("/app/login");
		const signInUrl = new URL(
			"/api/auth/sign-in/email",
			viewer.url()
		).toString();
		const ownerSignIn = await viewerContext.request.post(signInUrl, {
			headers: { Origin: new URL(viewer.url()).origin },
			data: {
				email: "owner@example.test",
				password: "Browser-test-password-123!",
			},
		});
		expect(ownerSignIn.ok()).toBeTruthy();
		// Headless tabs stay visible. Dispatch the native visibility event that
		// drives session refetch, allowing Better Auth's five-second throttle.
		await expect
			.poll(
				async () => {
					await viewer.evaluate(() =>
						document.dispatchEvent(new Event("visibilitychange"))
					);
					return viewer
						.getByRole("button", {
							name: "Create project",
							exact: true,
						})
						.count();
				},
				{ timeout: 10_000 }
			)
			.toBe(1);
		await otherTab.bringToFront();
		const viewerSignIn = await viewerContext.request.post(signInUrl, {
			headers: { Origin: new URL(viewer.url()).origin },
			data: {
				email: "viewer@example.test",
				password: "Browser-test-password-123!",
			},
		});
		expect(viewerSignIn.ok()).toBeTruthy();
		await expect
			.poll(
				async () => {
					await viewer.evaluate(() =>
						document.dispatchEvent(new Event("visibilitychange"))
					);
					return viewer
						.getByRole("button", {
							name: "Create project",
							exact: true,
						})
						.count();
				},
				{ timeout: 10_000 }
			)
			.toBe(0);
		await expect(
			viewer.getByRole("heading", { name: "Launch pilot", exact: true })
		).toBeVisible();
	} finally {
		await viewerContext.close();
	}
});

test("signing out in another tab removes the mounted private screen", async ({
	page,
	browser,
}) => {
	const viewerContext = await browser.newContext();
	try {
		const viewer = await joinedViewer(page, viewerContext);
		const otherTab = await viewerContext.newPage();
		await otherTab.goto("/app/login");
		await otherTab
			.getByRole("button", { name: "Sign out", exact: true })
			.click();
		await viewer.bringToFront();
		await expect(
			viewer.getByRole("heading", { name: "Sign in", exact: true })
		).toBeVisible();
		await expect(
			viewer.getByText("Plan the pilot.", { exact: true })
		).toHaveCount(0);
	} finally {
		await viewerContext.close();
	}
});
