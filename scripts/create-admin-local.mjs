import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs as parseCommandLine } from "node:util";

import SqliteDatabase from "better-sqlite3";
import { hashPassword } from "better-auth/crypto";
import { loadLocalEnv } from "./local-env.mjs";

const USAGE =
	"Usage: node scripts/create-admin-local.mjs [--email you@example.com] [--force-reset-password]";

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function randomPassword(length = 32) {
	const alphabet =
		"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
	const bytes = crypto.randomBytes(length);
	let out = "";
	// 256 is a multiple of the 64-character alphabet, so there is no bias.
	for (const byte of bytes) out += alphabet.charAt(byte % alphabet.length);
	return out;
}

// Strict: a mistyped flag such as --emial must not fall back to ADMIN_EMAIL
// and create or reset that administrator instead.
/** @param {string[]} argv */
function parseArgs(argv) {
	let parsed;
	try {
		parsed = parseCommandLine({
			args: argv,
			options: {
				email: { type: "string" },
				"force-reset-password": { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			strict: true,
		});
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`
		);
		process.exit(2);
	}
	if (parsed.values.help) {
		process.stdout.write(`${USAGE}\n`);
		process.exit(0);
	}
	return {
		email: parsed.values.email,
		forceResetPassword: parsed.values["force-reset-password"] === true,
	};
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

/** @param {{ email: string; password: string }} credential */
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
		"Missing admin email. Set ADMIN_EMAIL in config/cloudflare.mjs localCloudflare.vars or pass --email you@example.com"
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
	const existingUserId =
		existingUser && typeof existingUser === "object" && "id" in existingUser
			? String(existingUser.id)
			: undefined;

	let userId;
	if (existingUserId !== undefined) {
		userId = existingUserId;
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

	const account =
		existingAccount && typeof existingAccount === "object"
			? existingAccount
			: undefined;
	const hasPassword =
		account !== undefined &&
		"password" in account &&
		typeof account.password === "string" &&
		account.password.length > 0;

	if (hasPassword && !args.forceResetPassword) {
		return { status: "already", email: emailLower };
	}

	const password = randomPassword();
	return {
		status: "needs_password",
		email: emailLower,
		userId,
		existingAccountId:
			account !== undefined && "id" in account
				? String(account.id)
				: null,
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
const { password, userId } = result;
if (password === undefined || userId === undefined)
	throw new Error("Invariant violated: a new password needs a user id.");

const passwordHash = await hashPassword(password);

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
		).run(accountRowId, userId, userId, passwordHash, now);
	}
});

writePassword();

const passwordFile = writeAdminPasswordFile({
	email: result.email,
	password,
});

process.stdout.write(`Created/updated admin user: ${result.email}\n`);
process.stdout.write(`Password (printed once): ${password}\n`);
process.stdout.write(`Saved: ${path.relative(process.cwd(), passwordFile)}\n`);
