import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type {
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceFileChange,
	RuntimeWorkspaceFileStatus,
} from "../core/api-contract";
import { getGitStdout } from "./git-utils";

const WORKSPACE_CHANGES_CACHE_MAX_ENTRIES = 128;
const HEAD_REF = "HEAD";

interface WorkspaceChangesCacheEntry {
	stateKey: string;
	response: RuntimeWorkspaceChangesResponse;
	lastAccessedAt: number;
}

const workspaceChangesCacheByKey = new Map<string, WorkspaceChangesCacheEntry>();

interface NameStatusEntry {
	path: string;
	status: RuntimeWorkspaceFileStatus;
	previousPath?: string;
}

interface ChangesBetweenRefsInput {
	cwd: string;
	fromRef: string;
	toRef: string;
}

interface ChangesFromRefInput {
	cwd: string;
	fromRef: string;
}

interface ChangesSinceBaseRefInput {
	cwd: string;
	baseRef: string;
}

interface DiffStat {
	additions: number;
	deletions: number;
}

interface FileFingerprint {
	path: string;
	size: number | null;
	mtimeMs: number | null;
	ctimeMs: number | null;
}

function mapNameStatus(code: string): RuntimeWorkspaceFileStatus {
	const kind = code.charAt(0);
	if (kind === "M") return "modified";
	if (kind === "A") return "added";
	if (kind === "D") return "deleted";
	if (kind === "R") return "renamed";
	if (kind === "C") return "copied";
	return "unknown";
}

function toLineCount(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split("\n").length;
}

function parseTrackedChanges(output: string): NameStatusEntry[] {
	const entries: NameStatusEntry[] = [];
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		const parts = line.split("\t");
		const statusCode = parts[0];
		const status = mapNameStatus(statusCode);

		if ((status === "renamed" || status === "copied") && parts.length >= 3) {
			const previousPath = parts[1];
			const path = parts[2];
			if (path) {
				entries.push({
					path,
					previousPath: previousPath || undefined,
					status,
				});
			}
			continue;
		}

		const path = parts[1];
		if (path) {
			entries.push({
				path,
				status,
			});
		}
	}

	return entries;
}

function collectWorkingTreeChanges(trackedChangesOutput: string, untrackedOutput: string): NameStatusEntry[] {
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	const trackedPaths = new Set(trackedChanges.map((entry) => entry.path));
	const untrackedPaths = untrackedOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	return [
		...trackedChanges,
		...untrackedPaths
			.filter((path) => !trackedPaths.has(path))
			.map((path) => ({
				path,
				status: "untracked" as const,
			})),
	];
}

async function buildFileFingerprints(repoRoot: string, paths: string[]): Promise<FileFingerprint[]> {
	if (paths.length === 0) {
		return [];
	}
	const uniqueSortedPaths = Array.from(new Set(paths)).sort((left, right) => left.localeCompare(right));
	const entries = await Promise.all(
		uniqueSortedPaths.map(async (path) => {
			const absolutePath = join(repoRoot, path);
			try {
				const fileStat = await stat(absolutePath);
				return {
					path,
					size: fileStat.size,
					mtimeMs: fileStat.mtimeMs,
					ctimeMs: fileStat.ctimeMs,
				} satisfies FileFingerprint;
			} catch {
				return {
					path,
					size: null,
					mtimeMs: null,
					ctimeMs: null,
				} satisfies FileFingerprint;
			}
		}),
	);
	return entries;
}

function buildWorkspaceChangesStateKey(input: {
	cacheKey: string;
	fromCommit: string | null;
	trackedChangesOutput: string;
	untrackedOutput: string;
	fingerprints: FileFingerprint[];
}): string {
	const fingerprintsToken = input.fingerprints
		.map((entry) => `${entry.path}\t${entry.size ?? "null"}\t${entry.mtimeMs ?? "null"}\t${entry.ctimeMs ?? "null"}`)
		.join("\n");
	return [
		input.cacheKey,
		input.fromCommit ?? "no-commit",
		input.trackedChangesOutput,
		input.untrackedOutput,
		fingerprintsToken,
	].join("\n--\n");
}

function pruneWorkspaceChangesCache(): void {
	if (workspaceChangesCacheByKey.size <= WORKSPACE_CHANGES_CACHE_MAX_ENTRIES) {
		return;
	}
	const entries = Array.from(workspaceChangesCacheByKey.entries()).sort(
		(left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
	);
	const removeCount = entries.length - WORKSPACE_CHANGES_CACHE_MAX_ENTRIES;
	for (let index = 0; index < removeCount; index += 1) {
		const candidate = entries[index];
		if (!candidate) {
			break;
		}
		workspaceChangesCacheByKey.delete(candidate[0]);
	}
}

function readCachedWorkspaceChanges(cacheKey: string, stateKey: string): RuntimeWorkspaceChangesResponse | null {
	const existing = workspaceChangesCacheByKey.get(cacheKey);
	if (!existing || existing.stateKey !== stateKey) {
		return null;
	}
	existing.lastAccessedAt = Date.now();
	return existing.response;
}

function writeCachedWorkspaceChanges(
	cacheKey: string,
	stateKey: string,
	response: RuntimeWorkspaceChangesResponse,
): void {
	workspaceChangesCacheByKey.set(cacheKey, {
		stateKey,
		response,
		lastAccessedAt: Date.now(),
	});
	pruneWorkspaceChangesCache();
}

async function tryGetGitStdout(repoRoot: string, args: string[]): Promise<string | null> {
	try {
		const output = (await getGitStdout(args, repoRoot)).trim();
		return output.length > 0 ? output : null;
	} catch {
		return null;
	}
}

async function resolveRepoRoot(cwd: string): Promise<string> {
	const repoRoot = (await getGitStdout(["rev-parse", "--show-toplevel"], cwd)).trim();
	if (!repoRoot) {
		throw new Error("Could not resolve git repository root.");
	}
	return repoRoot;
}

async function readFileAtRef(repoRoot: string, ref: string, path: string): Promise<string | null> {
	try {
		return await getGitStdout(["show", `${ref}:${path}`], repoRoot);
	} catch {
		return null;
	}
}

async function readWorkingTreeFile(repoRoot: string, path: string): Promise<string | null> {
	try {
		return await readFile(join(repoRoot, path), "utf8");
	} catch {
		return null;
	}
}

function fallbackStats(oldText: string | null, newText: string | null): DiffStat {
	if (oldText == null && newText == null) {
		return { additions: 0, deletions: 0 };
	}
	if (oldText == null) {
		return { additions: toLineCount(newText ?? ""), deletions: 0 };
	}
	if (newText == null) {
		return { additions: 0, deletions: toLineCount(oldText) };
	}

	const oldLines = toLineCount(oldText);
	const newLines = toLineCount(newText);
	return {
		additions: Math.max(newLines - oldLines, 0),
		deletions: Math.max(oldLines - newLines, 0),
	};
}

function parseNumstat(output: string): DiffStat | null {
	const firstLine = output
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) {
		return null;
	}
	const [addedRaw, deletedRaw] = firstLine.split("\t");
	const additions = Number.parseInt(addedRaw ?? "", 10);
	const deletions = Number.parseInt(deletedRaw ?? "", 10);
	return {
		additions: Number.isFinite(additions) ? additions : 0,
		deletions: Number.isFinite(deletions) ? deletions : 0,
	};
}

async function readDiffStat(repoRoot: string, revisions: string[], path: string): Promise<DiffStat | null> {
	try {
		return parseNumstat(await getGitStdout(["diff", "--numstat", ...revisions, "--", path], repoRoot));
	} catch {
		return null;
	}
}

async function buildFileChange(
	repoRoot: string,
	entry: NameStatusEntry,
	fromRef: string,
): Promise<RuntimeWorkspaceFileChange> {
	const basePath = entry.previousPath ?? entry.path;
	const oldText =
		entry.status === "added" || entry.status === "untracked"
			? null
			: await readFileAtRef(repoRoot, fromRef, basePath);
	const newText = entry.status === "deleted" ? null : await readWorkingTreeFile(repoRoot, entry.path);
	const stats =
		entry.status === "untracked"
			? { additions: toLineCount(newText ?? ""), deletions: 0 }
			: ((await readDiffStat(repoRoot, [fromRef], entry.path)) ?? fallbackStats(oldText, newText));

	return {
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats.additions,
		deletions: stats.deletions,
		oldText,
		newText,
	};
}

async function buildFileChangeBetweenRefs(
	repoRoot: string,
	entry: NameStatusEntry,
	fromRef: string,
	toRef: string,
): Promise<RuntimeWorkspaceFileChange> {
	const basePath = entry.previousPath ?? entry.path;
	const oldText = entry.status === "added" ? null : await readFileAtRef(repoRoot, fromRef, basePath);
	const newText = entry.status === "deleted" ? null : await readFileAtRef(repoRoot, toRef, entry.path);
	const stats = (await readDiffStat(repoRoot, [fromRef, toRef], entry.path)) ?? fallbackStats(oldText, newText);

	return {
		path: entry.path,
		previousPath: entry.previousPath,
		status: entry.status,
		additions: stats.additions,
		deletions: stats.deletions,
		oldText,
		newText,
	};
}

async function readWorkspaceChangesAgainstRef(
	repoRoot: string,
	fromRef: string,
): Promise<RuntimeWorkspaceChangesResponse> {
	const [trackedChangesOutput, untrackedOutput, fromCommitOutput] = await Promise.all([
		getGitStdout(["diff", "--name-status", "--find-renames", fromRef, "--"], repoRoot),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], repoRoot),
		tryGetGitStdout(repoRoot, ["rev-parse", "--verify", fromRef]),
	]);

	const allChanges = collectWorkingTreeChanges(trackedChangesOutput, untrackedOutput);
	const fingerprintPaths = allChanges.flatMap((entry) => [entry.path, entry.previousPath].filter(Boolean) as string[]);
	const fingerprints = await buildFileFingerprints(repoRoot, fingerprintPaths);
	// NB: the cache is keyed per diff base so working-copy, session, and turn diffs
	// of the same worktree do not evict each other under the detail view's polling.
	const cacheKey = `${repoRoot}\n${fromRef}`;
	const stateKey = buildWorkspaceChangesStateKey({
		cacheKey,
		fromCommit: fromCommitOutput,
		trackedChangesOutput,
		untrackedOutput,
		fingerprints,
	});
	const cached = readCachedWorkspaceChanges(cacheKey, stateKey);
	if (cached) {
		return cached;
	}

	const files = await Promise.all(allChanges.map((entry) => buildFileChange(repoRoot, entry, fromRef)));
	files.sort((left, right) => left.path.localeCompare(right.path));
	const response: RuntimeWorkspaceChangesResponse = {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
	writeCachedWorkspaceChanges(cacheKey, stateKey, response);
	return response;
}

// NB: task worktrees start detached at the base commit and agents are free to commit
// their work, so the session diff has to be anchored at the fork point. Diffing HEAD
// would drop every committed turn and report a clean worktree.
async function resolveSessionBaseRef(repoRoot: string, baseRef: string): Promise<string> {
	const mergeBase = await tryGetGitStdout(repoRoot, ["merge-base", HEAD_REF, baseRef]);
	if (mergeBase) {
		return mergeBase;
	}
	return (await tryGetGitStdout(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])) ?? HEAD_REF;
}

export async function createEmptyWorkspaceChangesResponse(cwd: string): Promise<RuntimeWorkspaceChangesResponse> {
	return {
		repoRoot: await resolveRepoRoot(cwd),
		generatedAt: Date.now(),
		files: [],
	};
}

/** Uncommitted changes only: the working tree against its own HEAD. */
export async function getWorkspaceChanges(cwd: string): Promise<RuntimeWorkspaceChangesResponse> {
	return await readWorkspaceChangesAgainstRef(await resolveRepoRoot(cwd), HEAD_REF);
}

/** Everything a task session produced: committed turns plus the current working tree. */
export async function getWorkspaceChangesSinceBaseRef(
	input: ChangesSinceBaseRefInput,
): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = await resolveRepoRoot(input.cwd);
	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task base branch is required for workspace changes.");
	}
	return await readWorkspaceChangesAgainstRef(repoRoot, await resolveSessionBaseRef(repoRoot, baseRef));
}

export async function getWorkspaceChangesBetweenRefs(
	input: ChangesBetweenRefsInput,
): Promise<RuntimeWorkspaceChangesResponse> {
	const repoRoot = await resolveRepoRoot(input.cwd);
	const trackedChangesOutput = await getGitStdout(
		["diff", "--name-status", "--find-renames", input.fromRef, input.toRef, "--"],
		repoRoot,
	);
	const trackedChanges = parseTrackedChanges(trackedChangesOutput);
	if (trackedChanges.length === 0) {
		return {
			repoRoot,
			generatedAt: Date.now(),
			files: [],
		};
	}

	const files = await Promise.all(
		trackedChanges.map((entry) => buildFileChangeBetweenRefs(repoRoot, entry, input.fromRef, input.toRef)),
	);
	files.sort((left, right) => left.path.localeCompare(right.path));

	return {
		repoRoot,
		generatedAt: Date.now(),
		files,
	};
}

export async function getWorkspaceChangesFromRef(input: ChangesFromRefInput): Promise<RuntimeWorkspaceChangesResponse> {
	return await readWorkspaceChangesAgainstRef(await resolveRepoRoot(input.cwd), input.fromRef);
}
