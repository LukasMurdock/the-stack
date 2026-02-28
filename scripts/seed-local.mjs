import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SqliteDatabase = require("better-sqlite3");

function runNpmScript(name) {
	process.stdout.write(`\n> npm run ${name}\n`);
	execFileSync("npm", ["run", name], { stdio: "inherit" });
}

function findSqlitePath(tableName) {
	return execFileSync("node", ["scripts/find-d1-sqlite.mjs", tableName], {
		encoding: "utf8",
	}).trim();
}

function weekStartMs(tsMs) {
	const d = new Date(tsMs);
	const day = d.getUTCDay();
	const diff = (day + 6) % 7;
	d.setUTCHours(0, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() - diff);
	return d.getTime();
}

function iso(tsMs) {
	return new Date(tsMs).toISOString();
}

runNpmScript("db:core:migrate:local");
runNpmScript("db:turret:migrate:local");

const coreDb = new SqliteDatabase(findSqlitePath("core_users"));
const turretDb = new SqliteDatabase(findSqlitePath("turret_sessions"));

const now = Date.now();
const oneDay = 24 * 60 * 60 * 1000;
const retention = now + 30 * oneDay;

const demoUsers = [
	{ userId: "velocity-user-1", email: "velocity-demo-1@example.com" },
	{ userId: "velocity-user-2", email: "velocity-demo-2@example.com" },
	{ userId: "velocity-user-3", email: "velocity-demo-3@example.com" },
];

coreDb.exec("BEGIN");
try {
	coreDb
		.prepare(
			"delete from core_users where email like 'velocity-demo-%@example.com'"
		)
		.run();
	const insertCoreUser = coreDb.prepare(
		"insert into core_users (email) values (?)"
	);
	for (const user of demoUsers) {
		insertCoreUser.run(user.email);
	}
	coreDb.exec("COMMIT");
} catch (error) {
	coreDb.exec("ROLLBACK");
	throw error;
}

turretDb.exec("BEGIN");
try {
	turretDb
		.prepare(
			"delete from turret_session_errors where session_id like 'velocity-session-%'"
		)
		.run();
	turretDb
		.prepare(
			"delete from turret_user_feedback where session_id like 'velocity-session-%'"
		)
		.run();
	turretDb
		.prepare(
			"delete from turret_session_chunks where session_id like 'velocity-session-%'"
		)
		.run();
	turretDb
		.prepare(
			"delete from turret_sessions where session_id like 'velocity-session-%'"
		)
		.run();
	turretDb
		.prepare(
			"delete from turret_user_activity_weekly where user_id like 'velocity-user-%'"
		)
		.run();
	turretDb
		.prepare(
			"delete from turret_user_profile where user_id like 'velocity-user-%'"
		)
		.run();
	turretDb
		.prepare(
			"delete from turret_issue_state where fingerprint like 'velocity-fp-%'"
		)
		.run();

	const insertProfile = turretDb.prepare(
		"insert into turret_user_profile (user_id, signed_up_at_ms, signed_up_week_start_ms, created_at, updated_at) values (?, ?, ?, ?, ?)"
	);
	const insertWeekly = turretDb.prepare(
		"insert into turret_user_activity_weekly (user_id, week_start_ms, first_seen_at) values (?, ?, ?)"
	);
	const insertSession = turretDb.prepare(
		"insert into turret_sessions (session_id, started_at, ended_at, initial_url, last_url, user_agent, country, colo, journey_id, user_id, user_email, worker_version_id, worker_version_tag, worker_version_timestamp, rrweb_start_ts_ms, rrweb_last_ts_ms, has_error, capture_blocked, capture_blocked_reason, error_count, chunk_count, policy_version, retention_expires_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	);
	const insertError = turretDb.prepare(
		"insert into turret_session_errors (id, session_id, ts, source, message, stack, fingerprint, extra_json, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	);
	const insertIssue = turretDb.prepare(
		"insert into turret_issue_state (fingerprint, status, title, created_at, updated_at) values (?, 'open', ?, ?, ?)"
	);
	const insertFeedback = turretDb.prepare(
		"insert into turret_user_feedback (id, session_id, user_id, user_email, ts, url, kind, message, contact, extra_json, status, expires_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)"
	);

	for (let i = 0; i < demoUsers.length; i++) {
		const user = demoUsers[i];
		const signedUpAt = now - (20 - i * 4) * oneDay;
		insertProfile.run(
			user.userId,
			signedUpAt,
			weekStartMs(signedUpAt),
			now,
			now
		);

		for (let w = 0; w < 4; w++) {
			const ts = now - w * 7 * oneDay;
			insertWeekly.run(user.userId, weekStartMs(ts), ts);
		}

		for (let s = 0; s < 2; s++) {
			const startedAt = now - (i * 4 + s + 1) * 60 * 60 * 1000;
			const endedAt = startedAt + (5 + s) * 60 * 1000;
			const sessionId = `velocity-session-${i + 1}-${s + 1}`;
			const hasError = i === 0 && s === 0 ? 1 : 0;
			const fingerprint = `velocity-fp-${i + 1}`;

			insertSession.run(
				sessionId,
				startedAt,
				endedAt,
				"/app",
				"/app/status",
				"Mozilla/5.0 (Macintosh; Intel Mac OS X)",
				"US",
				"SJC",
				`velocity-journey-${i + 1}`,
				user.userId,
				user.email,
				"local-dev",
				"local",
				iso(now),
				startedAt,
				endedAt,
				hasError,
				0,
				null,
				hasError,
				0,
				"seed-v1",
				retention,
				now,
				now
			);

			if (hasError) {
				insertError.run(
					crypto.randomUUID(),
					sessionId,
					startedAt + 2 * 60 * 1000,
					"window",
					"Seeded demo error",
					null,
					fingerprint,
					JSON.stringify({ seeded: true }),
					retention,
					now
				);
				insertIssue.run(
					fingerprint,
					"Seeded issue for demo triage",
					now,
					now
				);
			}
		}
	}

	insertFeedback.run(
		crypto.randomUUID(),
		"velocity-session-1-1",
		demoUsers[0].userId,
		demoUsers[0].email,
		now - 30 * 60 * 1000,
		"/app",
		"bug",
		"Seeded feedback: chart does not update fast enough.",
		demoUsers[0].email,
		JSON.stringify({ seeded: true }),
		retention,
		now,
		now
	);

	turretDb.exec("COMMIT");
} catch (error) {
	turretDb.exec("ROLLBACK");
	throw error;
}

process.stdout.write("\nSeed complete.\n");
process.stdout.write("- Added core demo users (core_users)\n");
process.stdout.write(
	"- Added Turret sessions, errors, and feedback demo records\n"
);
