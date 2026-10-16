// The git half of trunk-mode `pnpm ship`: read whether HEAD may land on main
// (clean tree, passing proof, fast-forward, production origin) and land it by
// pushing the commit and its proof note in one atomic push. Needs only git
// and an `origin` remote; no GitHub API. Every read here changes nothing, so
// `--dry-run` and the real run evaluate the same preconditions.

import { capture, COMMAND_TIMEOUT_MS, type ReleaseIo } from "../ci-wait.ts";
import {
	checkProof,
	formatChanges,
	PROOF_NOTES_REF,
	type ProofCheckOptions,
	WORKING_TREE_STATUS_ARGS,
	workingTreeChanges,
} from "./proof.ts";
import { productionOrigin, ReleaseError } from "./release.ts";

export const TRUNK_REMOTE = "origin";
export const TRUNK_BRANCH_REF = "refs/heads/main";
// origin's notes are fetched here, merged into PROOF_NOTES_REF, then deleted.
export const PROOF_NOTES_INCOMING_REF = "refs/notes/proof-incoming";
// A failed deploy can leave resource IDs Void recorded; the rerun must keep
// and reuse them (commit void.lock.json afterwards). The pushed commit, and so
// the proved tree, is unaffected.
export const DEPLOY_STATE_PATHS = ["void.lock.json"] as const;

const SHA_PATTERN = /^[0-9a-f]{40}$/;

export type Precondition = {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
};

export type RemoteRefs = {
	readonly mainSha: string | null;
	readonly notesSha: string | null;
};

// What landing needs once every precondition holds.
export type Landing = {
	readonly commit: string;
	readonly origin: string;
	readonly remote: RemoteRefs;
	readonly localNotesSha: string;
};

export type TrunkState = {
	readonly commit: string;
	readonly preconditions: readonly Precondition[];
	// null when any precondition failed.
	readonly landing: Landing | null;
};

export type TrunkStateInput = {
	readonly appUrl: string;
	readonly proof: ProofCheckOptions;
};

type RemoteRead =
	| { readonly kind: "read"; readonly refs: RemoteRefs }
	| { readonly kind: "unreachable"; readonly reason: string };

export function readTrunkState(
	io: ReleaseIo,
	input: TrunkStateInput
): TrunkState {
	const root = capture(io, "git", ["rev-parse", "--show-toplevel"]);
	const clean = checkCleanTree(io);
	const proof = checkProof("HEAD", input.proof, root);
	const commit = proof.target.commit;
	const remote = readRemoteRefs(io);
	const fastForward = checkFastForward(io, commit, remote);
	const origin = checkOrigin(input.appUrl);
	const preconditions = [
		clean,
		proofPrecondition(proof),
		fastForward,
		origin.precondition,
	];
	const allOk = preconditions.every((precondition) => precondition.ok);
	if (!allOk || remote.kind !== "read" || origin.value === null)
		return { commit, preconditions, landing: null };
	const localNotesSha = readLocalNotesSha(io);
	// A passing proof was read from this ref a moment ago.
	if (localNotesSha === null)
		throw new Error(`Invariant violated: ${PROOF_NOTES_REF} is missing.`);
	return {
		commit,
		preconditions,
		landing: {
			commit,
			origin: origin.value,
			remote: remote.refs,
			localNotesSha,
		},
	};
}

export function formatPreconditions(
	preconditions: readonly Precondition[]
): string {
	return preconditions
		.map((precondition) => {
			const mark = precondition.ok ? "ok  " : "FAIL";
			const detail = precondition.detail.replaceAll("\n", "\n        ");
			return `  ${mark}  ${precondition.name}: ${detail}`;
		})
		.join("\n");
}

function checkCleanTree(io: ReleaseIo): Precondition {
	const name = "clean tree";
	const status = capture(io, "git", [...WORKING_TREE_STATUS_ARGS]);
	const changes = workingTreeChanges(status, DEPLOY_STATE_PATHS);
	if (changes.length === 0)
		return {
			name,
			ok: true,
			detail: "no uncommitted or untracked changes",
		};
	return {
		name,
		ok: false,
		detail:
			"uncommitted or untracked changes are not in HEAD or its proof. Commit them " +
			`and run pnpm proof, or stash them, then rerun pnpm ship:\n${formatChanges(changes)}`,
	};
}

function proofPrecondition(proof: ReturnType<typeof checkProof>): Precondition {
	const name = "proof";
	const tree = proof.target.tree.slice(0, 12);
	if (proof.ok)
		return { name, ok: true, detail: `passing proof of tree ${tree}` };
	return {
		name,
		ok: false,
		detail:
			`${proof.reasons.join("\n")}\n` +
			"Run pnpm proof on this commit (pnpm proof --show prints the record), then rerun pnpm ship.",
	};
}

function readRemoteRefs(io: ReleaseIo): RemoteRead {
	// ls-remote reads origin's refs without updating any local ref, unlike
	// `git fetch`, so the dry run stays read-only and both modes decide on
	// origin's state at this moment.
	const result = io.exec(
		"git",
		["ls-remote", TRUNK_REMOTE, TRUNK_BRANCH_REF, PROOF_NOTES_REF],
		{ stdio: "capture", timeoutMs: COMMAND_TIMEOUT_MS }
	);
	if (result.status !== 0)
		return {
			kind: "unreachable",
			reason: (result.stderr || result.stdout).trim(),
		};
	return { kind: "read", refs: parseRemoteRefs(result.stdout) };
}

// `git ls-remote` output -> origin's main and proof-notes heads.
export function parseRemoteRefs(output: string): RemoteRefs {
	let mainSha: string | null = null;
	let notesSha: string | null = null;
	for (const line of output.split("\n")) {
		if (line.trim() === "") continue;
		const [sha, ref, ...extra] = line.trim().split("\t");
		if (sha === undefined || !SHA_PATTERN.test(sha) || extra.length > 0)
			throw new ReleaseError(`Unexpected git ls-remote line: ${line}`);
		if (ref === TRUNK_BRANCH_REF) mainSha = sha;
		if (ref === PROOF_NOTES_REF) notesSha = sha;
	}
	return { mainSha, notesSha };
}

function checkFastForward(
	io: ReleaseIo,
	commit: string,
	remote: RemoteRead
): Precondition {
	const name = "fast-forward";
	if (remote.kind === "unreachable")
		return {
			name,
			ok: false,
			detail: `cannot read ${TRUNK_REMOTE}: ${remote.reason}\nFix the remote or its credentials, then rerun pnpm ship.`,
		};
	const mainSha = remote.refs.mainSha;
	if (mainSha === null)
		return { name, ok: true, detail: `${TRUNK_REMOTE} has no main yet` };
	if (mainSha === commit)
		return { name, ok: true, detail: `${TRUNK_REMOTE} main is HEAD` };
	// A main HEAD descends from is in the local object store; a missing
	// object therefore means main moved past what this checkout has seen.
	if (hasCommit(io, mainSha) && isAncestor(io, mainSha, commit))
		return {
			name,
			ok: true,
			detail: `${TRUNK_REMOTE} main ${mainSha.slice(0, 12)} is an ancestor of HEAD`,
		};
	return {
		name,
		ok: false,
		detail:
			`${TRUNK_REMOTE} main moved to ${mainSha.slice(0, 12)}, which HEAD does not contain. ` +
			"Rebase onto it (git fetch origin main && git rebase origin/main), then rerun " +
			"pnpm proof (the proof is bound to the exact tree) and pnpm ship.",
	};
}

function checkOrigin(appUrl: string): {
	readonly precondition: Precondition;
	readonly value: string | null;
} {
	const name = "production origin";
	try {
		const value = productionOrigin(appUrl);
		return { precondition: { name, ok: true, detail: value }, value };
	} catch (error: unknown) {
		// The parse failure is this precondition's result, reported with the rest.
		if (!(error instanceof ReleaseError)) throw error;
		return {
			precondition: { name, ok: false, detail: error.message },
			value: null,
		};
	}
}

function hasCommit(io: ReleaseIo, sha: string): boolean {
	const result = io.exec("git", ["cat-file", "-e", `${sha}^{commit}`], {
		stdio: "capture",
		timeoutMs: COMMAND_TIMEOUT_MS,
	});
	return result.status === 0;
}

function isAncestor(io: ReleaseIo, ancestor: string, commit: string): boolean {
	const result = io.exec(
		"git",
		["merge-base", "--is-ancestor", ancestor, commit],
		{ stdio: "capture", timeoutMs: COMMAND_TIMEOUT_MS }
	);
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new ReleaseError(
		`git merge-base --is-ancestor ${ancestor} ${commit} failed: ${result.stderr.trim()}`
	);
}

function readLocalNotesSha(io: ReleaseIo): string | null {
	const result = io.exec(
		"git",
		["rev-parse", "--verify", "--quiet", PROOF_NOTES_REF],
		{ stdio: "capture", timeoutMs: COMMAND_TIMEOUT_MS }
	);
	if (result.status !== 0) return null;
	return result.stdout.trim();
}

// Landing is done when main is HEAD and origin's notes already contain every
// local note (equal, or local is an ancestor of origin's).
function alreadyLanded(io: ReleaseIo, landing: Landing): boolean {
	const { remote, commit, localNotesSha } = landing;
	if (remote.mainSha !== commit) return false;
	if (remote.notesSha === null) return false;
	if (remote.notesSha === localNotesSha) return true;
	return (
		hasCommit(io, remote.notesSha) &&
		isAncestor(io, localNotesSha, remote.notesSha)
	);
}

function pushArgs(commit: string): readonly string[] {
	return [
		"push",
		"--atomic",
		TRUNK_REMOTE,
		`${commit}:${TRUNK_BRANCH_REF}`,
		`${PROOF_NOTES_REF}:${PROOF_NOTES_REF}`,
	];
}

// The landing steps a run would take, for --dry-run.
export function describeLanding(io: ReleaseIo, landing: Landing): string[] {
	const { remote, localNotesSha } = landing;
	const steps: string[] = [];
	if (remote.notesSha !== null && remote.notesSha !== localNotesSha)
		steps.push(
			`fetch ${TRUNK_REMOTE}'s ${PROOF_NOTES_REF} into ${PROOF_NOTES_INCOMING_REF} and merge it (strategy ours)`
		);
	if (alreadyLanded(io, landing)) {
		steps.push(
			`skip the push: ${TRUNK_REMOTE} main is HEAD and has its proof note`
		);
	} else {
		steps.push(`git ${pushArgs(landing.commit).join(" ")}`);
	}
	return steps;
}

// Pushes HEAD to main together with the proof notes, or does nothing when an
// earlier run already landed it. Never forces: a ref that moved on origin
// rejects the whole atomic push, and the rerun re-evaluates.
export function landOnMain(
	io: ReleaseIo,
	landing: Landing
): "pushed" | "already-landed" {
	const { remote, commit } = landing;
	let localNotesSha = landing.localNotesSha;
	if (remote.notesSha !== null && remote.notesSha !== localNotesSha) {
		mergeRemoteNotes(io);
		const merged = readLocalNotesSha(io);
		if (merged === null)
			throw new Error(`Invariant violated: ${PROOF_NOTES_REF} vanished.`);
		localNotesSha = merged;
	}
	if (alreadyLanded(io, { ...landing, localNotesSha }))
		return "already-landed";
	const args = pushArgs(commit);
	io.log(`git ${args.join(" ")}`);
	const result = io.exec("git", args, {
		stdio: "capture",
		timeoutMs: COMMAND_TIMEOUT_MS,
	});
	if (result.status !== 0)
		throw new ReleaseError(
			`git push --atomic failed; nothing was pushed:\n${(result.stderr || result.stdout).trim()}\n` +
				"Rerun pnpm ship. If main moved, rebase onto origin/main and rerun pnpm proof first."
		);
	return "pushed";
}

// Someone else pushed notes for other commits since this checkout fetched.
// Strategy "ours": each side's notes for different commits are kept as they
// are, and for a commit both sides noted, the local note wins whole. union
// and cat_sort_uniq would concatenate two JSON records into one note that
// parseProofRecord rejects; manual would stop for hand resolution. Keeping the
// local side guarantees HEAD's note is the one checkProof just accepted.
function mergeRemoteNotes(io: ReleaseIo): void {
	io.log(`Merging ${TRUNK_REMOTE}'s ${PROOF_NOTES_REF} into the local notes`);
	// Dropping a leftover from an interrupted run lets the fetch below create
	// the ref without forcing it.
	deleteIncomingRef(io);
	capture(io, "git", [
		"fetch",
		"--no-tags",
		TRUNK_REMOTE,
		`${PROOF_NOTES_REF}:${PROOF_NOTES_INCOMING_REF}`,
	]);
	try {
		capture(io, "git", [
			"notes",
			`--ref=${PROOF_NOTES_REF}`,
			"merge",
			"--strategy=ours",
			"--quiet",
			PROOF_NOTES_INCOMING_REF,
		]);
	} finally {
		deleteIncomingRef(io);
	}
}

function deleteIncomingRef(io: ReleaseIo): void {
	const exists = io.exec(
		"git",
		["rev-parse", "--verify", "--quiet", PROOF_NOTES_INCOMING_REF],
		{ stdio: "capture", timeoutMs: COMMAND_TIMEOUT_MS }
	);
	if (exists.status !== 0) return;
	capture(io, "git", ["update-ref", "-d", PROOF_NOTES_INCOMING_REF]);
}
