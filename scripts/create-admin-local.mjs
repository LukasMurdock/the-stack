import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { hashPassword } from "better-auth/crypto";
import { loadLocalEnv } from "./local-env.mjs";

const require = createRequire(import.meta.url);
const SqliteDatabase = require("better-sqlite3");

function die(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function randomPassword(length = 32) {
	const alphabet =
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
	const bytes = crypto.randomBytes(length);
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += alphabet[bytes[i] % alphabet.length];
	}
	return out;
}

function parseArgs(argv) {
	const args = {
		email: undefined,
		forceResetPassword: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--email") {
			args.email = argv[i + 1];
			i++;
			continue;
		}
		if (a.startsWith("--email=")) {
			args.email = a.slice("--email=".length);
			continue;
		}
		if (a === "--force-reset-password") {
			args.forceResetPassword = true;
			continue;
		}
		if (a === "-h" || a === "--help") {
			process.stdout.write(
				"Usage: node scripts/create-admin-local.mjs [--email you@example.com] [--force-reset-password]\n"
			);
			process.exit(0);
		}
	}

	return args;
}

function findCoreDbSqlitePath() {
	const out = execFileSync(
		"node",
		["scripts/find-d1-sqlite.mjs", "core_users"],
		{ encoding: "utf8" }
	).trim();

	if (!out) die("Could not locate local CORE_DB sqlite file.");
	return path.resolve(process.cwd(), out);
}

function writeAdminPasswordFile({ email, password }) {
	const outPath = path.resolve(process.cwd(), ".wrangler/.admin-password");
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	const payload = {
		email,
		password,
		createdAt: new Date().toISOString(),
	};
	fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", {
		mode: 0o600,
	});
	return outPath;
}

const args = parseArgs(process.argv.slice(2));
const loaded = loadLocalEnv();
if (loaded.error) throw loaded.error;

const email = (args.email ?? process.env.ADMIN_EMAIL ?? "").trim();
if (!email) {
	die(
		"Missing admin email. Set ADMIN_EMAIL in wrangler.json vars or pass --email you@example.com"
	);
}

const emailLower = email.toLowerCase();

const dbPath = findCoreDbSqlitePath();
const db = new SqliteDatabase(dbPath);

db.pragma("journal_mode = WAL");

db.exec("PRAGMA foreign_keys = ON;");

const ensureAdmin = db.transaction(() => {
	const existingUser = db
		.prepare(
			"select id, email from auth_user where lower(email) = lower(?) limit 1"
		)
		.get(emailLower);

	let userId;
	if (existingUser) {
		userId = existingUser.id;
		// Normalize email casing + ensure admin role.
		db.prepare(
			"update auth_user set email = ?, role = 'admin', email_verified = 1 where id = ?"
		).run(emailLower, userId);
	} else {
		userId = crypto.randomUUID();
		db.prepare(
			"insert into auth_user (id, name, email, email_verified, role) values (?, ?, ?, 1, 'admin')"
		).run(userId, "Admin", emailLower);
	}

	const existingAccount = db
		.prepare(
			"select id, password from auth_account where user_id = ? and provider_id = 'credential' limit 1"
		)
		.get(userId);

	const hasPassword =
		!!existingAccount &&
		typeof existingAccount.password === "string" &&
		existingAccount.password.length > 0;

	if (hasPassword && !args.forceResetPassword) {
		return { status: "already", email: emailLower };
	}

	const password = randomPassword();
	return {
		status: "needs_password",
		email: emailLower,
		userId,
		existingAccountId: existingAccount?.id ?? null,
		password,
	};
});

const result = ensureAdmin();

if (result.status === "already") {
	process.stdout.write(
		`Admin user exists for ${result.email}; credential password unchanged (not printed).\n`
	);
	process.exit(0);
}

const passwordHash = await hashPassword(result.password);

const writePassword = db.transaction(() => {
	const now = Date.now();

	if (result.existingAccountId) {
		db.prepare(
			"update auth_account set password = ?, updated_at = ? where id = ?"
		).run(passwordHash, now, result.existingAccountId);
	} else {
		const accountRowId = crypto.randomUUID();
		db.prepare(
			"insert into auth_account (id, account_id, provider_id, user_id, password, updated_at) values (?, ?, 'credential', ?, ?, ?)"
		).run(accountRowId, result.userId, result.userId, passwordHash, now);
	}
});

writePassword();

const passwordFile = writeAdminPasswordFile({
	email: result.email,
	password: result.password,
});

process.stdout.write(`Created/updated admin user: ${result.email}\n`);
process.stdout.write(`Password (printed once): ${result.password}\n`);
process.stdout.write(`Saved: ${path.relative(process.cwd(), passwordFile)}\n`);
