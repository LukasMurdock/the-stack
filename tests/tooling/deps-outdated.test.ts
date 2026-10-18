import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	bumpOf,
	formatReport,
	nodeMajorOf,
	parseOutdated,
} from "../../scripts/deps-outdated.ts";

const report = JSON.stringify({
	wrangler: {
		current: "4.151.0",
		latest: "4.151.1",
		wanted: "4.151.0",
		isDeprecated: false,
		dependencyType: "devDependencies",
	},
	zod: {
		current: "4.1.0",
		latest: "4.3.2",
		wanted: "4.1.0",
		isDeprecated: false,
		dependencyType: "dependencies",
	},
	react: {
		current: "19.2.0",
		latest: "20.0.0",
		wanted: "19.2.0",
		isDeprecated: false,
		dependencyType: "dependencies",
	},
	"@types/node": {
		current: "24.19.2",
		latest: "26.6.5",
		wanted: "24.19.2",
		isDeprecated: false,
		dependencyType: "devDependencies",
	},
	"old-thing": {
		current: "0.4.1",
		latest: "0.5.0",
		wanted: "0.4.1",
		isDeprecated: true,
		dependencyType: "dependencies",
	},
});

test("bumps follow semver, with 0.y changes and odd versions as major", () => {
	assert.equal(bumpOf("4.151.0", "4.151.1"), "patch");
	assert.equal(bumpOf("4.1.0", "4.3.2"), "minor");
	assert.equal(bumpOf("19.2.0", "20.0.0"), "major");
	assert.equal(bumpOf("0.4.1", "0.5.0"), "major");
	assert.equal(bumpOf("0.4.1", "0.4.2"), "patch");
	assert.equal(bumpOf("latest", "1.0.0"), "major");
});

test("the report batches patch and minor, and lists majors and deprecations", () => {
	const text = formatReport(parseOutdated(report, 24));
	assert.match(text, /## Patch and minor \(2\)/);
	assert.match(text, /pnpm update --latest wrangler zod\n/);
	assert.match(
		text,
		/## Major \(2\)[\s\S]*\| old-thing \|[\s\S]*\| react \|/
	);
	assert.match(text, /## Deprecated \(1\): replace\n\n- old-thing/);
	// @types/node follows the runtime major, so 26 is held, not offered.
	assert.match(
		text,
		/## Held \(1\)\n\n- @types\/node 26\.6\.5: follows the Node 24 runtime/
	);
	assert.doesNotMatch(text, /\| @types\/node \|/);
	assert.equal(nodeMajorOf(">=24.21.0"), 24);
	assert.equal(nodeMajorOf(undefined), null);
	assert.equal(formatReport([]), "All dependencies are up to date.\n");
});

function runWithFakePnpm(
	args: readonly string[],
	stdout: string,
	code: number
) {
	const dir = mkdtempSync(path.join(tmpdir(), "deps-outdated-"));
	try {
		writeFileSync(path.join(dir, "out.json"), stdout);
		const fake = path.join(dir, "pnpm");
		writeFileSync(
			fake,
			`#!/bin/sh\ncat "${path.join(dir, "out.json")}"\nexit ${code}\n`
		);
		chmodSync(fake, 0o755);
		return spawnSync(
			process.execPath,
			[path.resolve("scripts/deps-outdated.ts"), ...args],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
			}
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the command prints the report although pnpm outdated exits 1", () => {
	const result = runWithFakePnpm([], report, 1);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /# Outdated dependencies \(5\)/);
});

test("the command fails on an unreadable report and refuses arguments", () => {
	const broken = runWithFakePnpm([], "not json", 1);
	assert.equal(broken.status, 1);
	const usage = runWithFakePnpm(["--bogus"], report, 1);
	assert.equal(usage.status, 2);
	assert.match(usage.stderr, /Usage: pnpm deps:outdated/);
});
