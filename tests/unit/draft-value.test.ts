import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { useDraftValue } from "../../src/react-app/hooks/useDraftValue";

test("drafts follow server data until edited, preserve edits during refetches, and reset across records", async (t) => {
	const dom = new JSDOM("<div id='root'></div>");
	const previousWindow = Object.getOwnPropertyDescriptor(
		globalThis,
		"window"
	);
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		"document"
	);
	Object.defineProperty(globalThis, "window", {
		value: dom.window,
		configurable: true,
	});
	Object.defineProperty(globalThis, "document", {
		value: dom.window.document,
		configurable: true,
	});
	Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
		value: true,
		configurable: true,
	});
	const container = dom.window.document.getElementById("root")!;
	const root = createRoot(container);
	t.after(async () => {
		await act(() => root.unmount());
		dom.window.close();
		for (const [name, descriptor] of [
			["window", previousWindow],
			["document", previousDocument],
		] as const) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	});
	let draft: ReturnType<typeof useDraftValue<string>> | undefined;
	function Field({
		initialValue,
		scope,
	}: {
		initialValue: string;
		scope: string;
	}) {
		const current = useDraftValue(initialValue, scope);
		useLayoutEffect(() => {
			draft = current;
		});
		return createElement("output", null, current.value);
	}
	async function render(initialValue: string, scope = "a") {
		await act(() =>
			root.render(createElement(Field, { initialValue, scope }))
		);
		return container.textContent;
	}
	assert.equal(await render(""), "");
	assert.equal(await render("loaded"), "loaded");
	await act(() => draft!.setValue("edited"));
	assert.equal(await render("refetched"), "edited");
	await act(() => draft!.setValue((value) => `${value}!`));
	assert.equal(container.textContent, "edited!");
	await act(() => draft!.reset());
	assert.equal(container.textContent, "refetched");
	await act(() => draft!.setValue("unsaved"));
	const staleReset = draft!.reset;
	assert.equal(await render("other record", "b"), "other record");
	await act(() => draft!.setValue("other edit"));
	await act(() => staleReset());
	assert.equal(container.textContent, "other edit");
	assert.equal(await render("returned", "a"), "returned");
});
