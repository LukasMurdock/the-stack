import { expect, test } from "@playwright/test";

test("admin parent denies a signed-in non-admin without a login loop", async ({
	page,
}) => {
	await page.goto("/app/login");
	await page.getByLabel("Email", { exact: true }).fill("viewer@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("Browser-test-password-123!");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).not.toHaveURL(/\/app\/login/);
	await page.goto("/app/ts_admin/users/viewer");
	await expect(
		page.getByText("Administrator access is required.", { exact: false })
	).toBeVisible();
	expect(page.url()).toContain("/app/ts_admin/users/viewer");
});

test("marketing and docs layouts execute their compiled replay entry", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	for (const path of ["/", "/docs/v1/extend"]) {
		const [session] = await Promise.all([
			page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/api/auth/get-session"
			),
			page.goto(path),
		]);
		expect(session.ok()).toBe(true);
		expect(errors).toEqual([]);
	}
});

test("Astro replay starts only for authenticated sessions and tolerates session failures", async ({
	page,
	baseURL,
}) => {
	if (!baseURL) throw new Error("The Worker base URL is required.");
	const initializations: string[] = [];
	page.on("request", (request) => {
		if (
			new URL(request.url()).pathname ===
			"/api/turret/replay-session/init"
		)
			initializations.push(request.url());
	});
	for (const path of ["/", "/docs/v1/extend"]) {
		await page.goto(path);
		await page.waitForLoadState("networkidle");
	}
	expect(initializations).toHaveLength(0);
	await page.route("**/api/auth/get-session", (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({ message: "Session unavailable" }),
		})
	);
	await page.goto("/");
	await page.waitForLoadState("networkidle");
	expect(initializations).toHaveLength(0);
	await page.unroute("**/api/auth/get-session");
	const signedIn = await page
		.context()
		.request.post("/api/auth/sign-in/email", {
			headers: { Origin: baseURL },
			data: {
				email: "admin@example.test",
				password: "Browser-test-password-123!",
			},
		});
	expect(signedIn.ok()).toBe(true);
	for (const path of ["/", "/docs/v1/extend"]) {
		const [initialized] = await Promise.all([
			page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname ===
					"/api/turret/replay-session/init"
			),
			page.goto(path),
		]);
		expect(initialized.ok()).toBe(true);
	}
	expect(initializations).toHaveLength(2);
});

test("login offers Google only when the server reports it available", async ({
	page,
}) => {
	let enabled = false;
	await page.route("**/api/health", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		await route.fulfill({
			response,
			json: {
				...body,
				auth: { ...body.auth, googleSignInEnabled: enabled },
			},
		});
	});
	await page.goto("/app/login");
	await expect(
		page.getByRole("button", { name: "Sign in", exact: true })
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Continue with Google" })
	).toHaveCount(0);
	enabled = true;
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Continue with Google" })
	).toBeVisible();
});

test("an open Astro tab replaces capture on account change and stops after cross-tab sign-out", async ({
	page,
	context,
	baseURL,
}) => {
	if (!baseURL) throw new Error("The Worker base URL is required.");
	const signIn = async (email: string) => {
		const response = await context.request.post("/api/auth/sign-in/email", {
			headers: { Origin: baseURL },
			data: { email, password: "Browser-test-password-123!" },
		});
		expect(response.ok()).toBe(true);
	};
	await signIn("admin@example.test");
	let chunks = 0;
	let initializations = 0;
	await page.clock.install();
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.endsWith("/chunk") && request.method() === "POST") chunks++;
		if (path === "/api/turret/replay-session/init") initializations++;
	});
	const [initial] = await Promise.all([
		page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname ===
				"/api/turret/replay-session/init"
		),
		page.goto("/docs/v1/extend"),
	]);
	const first = await initial.json();
	await expect.poll(() => chunks).toBeGreaterThan(0);
	const otherTab = await context.newPage();
	await otherTab.goto("/app/login");
	await signIn("viewer@example.test");
	const replacement = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname ===
			"/api/turret/replay-session/init"
	);
	// Browser authentication changes become observable through Better Auth's
	// broadcast or focus refresh; headless tabs need the visibility event.
	await expect
		.poll(
			async () => {
				await page.evaluate(() =>
					document.dispatchEvent(new Event("visibilitychange"))
				);
				return initializations;
			},
			{ timeout: 10_000 }
		)
		.toBe(2);
	const replaced = await replacement;
	const second = await replaced.json();
	expect(second.session_id).not.toBe(first.session_id);
	await page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname ===
			`/api/turret/replay-session/${second.session_id}/chunk`
	);
	await otherTab.reload();
	const signedOut = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/auth/get-session"
	);
	await otherTab
		.getByRole("button", { name: "Sign out", exact: true })
		.click();
	expect(await (await signedOut).json()).toBeNull();
	await page.waitForLoadState("networkidle");
	const before = chunks;
	await page.evaluate(() => {
		const node = document.createElement("div");
		node.textContent = "Activity after sign-out";
		document.body.appendChild(node);
	});
	await page.clock.runFor(5000);
	expect(chunks).toBe(before);
});
