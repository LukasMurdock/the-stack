import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
	captureInvitationLink,
	invitationToken,
	clearInvitationToken,
	invitationLink,
} from "../../src/react-app/features/organizations/invitationToken";

for (const basepath of ["/app", "/workspace", "/nested/app/"]) {
	test(`invitation URLs at ${basepath} are scrubbed before storage and work when storage is blocked`, (t) => {
		const token = crypto.randomUUID();
		const dom = new JSDOM("", {
			url: invitationLink("https://app.test", token, basepath),
		});
		const descriptors = ["window", "sessionStorage"].map(
			(key) =>
				[key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
		);
		Object.defineProperty(globalThis, "window", {
			value: dom.window,
			configurable: true,
		});
		Object.defineProperty(globalThis, "sessionStorage", {
			configurable: true,
			get() {
				throw new Error("Storage denied");
			},
		});
		t.after(() => {
			clearInvitationToken();
			dom.window.close();
			for (const [key, descriptor] of descriptors) {
				if (descriptor)
					Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		});
		assert.doesNotThrow(() => captureInvitationLink(basepath));
		assert.equal(dom.window.location.hash, "");
		assert.equal(invitationToken(), token);
		dom.window.history.replaceState(
			null,
			"",
			`${basepath.replace(/\/$/, "")}/login`
		);
		assert.equal(
			invitationToken(),
			token,
			"SPA sign-in navigation preserves the token"
		);
		clearInvitationToken();
		assert.equal(invitationToken(), undefined);
		dom.window.history.replaceState(
			null,
			"",
			invitationLink("https://app.test", "invalid", basepath)
		);
		captureInvitationLink(basepath);
		assert.equal(dom.window.location.hash, "");
		assert.equal(invitationToken(), undefined);
		dom.window.history.replaceState(
			null,
			"",
			`${basepath.replace(/\/$/, "")}/organizations#section`
		);
		captureInvitationLink(basepath);
		assert.equal(
			dom.window.location.hash,
			"#section",
			"unrelated anchors must be preserved"
		);
	});
}
