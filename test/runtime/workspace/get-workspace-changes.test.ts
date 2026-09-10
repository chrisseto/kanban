import { beforeEach, describe, expect, it, vi } from "vitest";

const gitMocks = vi.hoisted(() => ({
	getGitStdout: vi.fn(),
}));

vi.mock("../../../src/workspace/git-utils", () => ({
	getGitStdout: gitMocks.getGitStdout,
}));

const fsMocks = vi.hoisted(() => ({
	readFile: vi.fn(),
	stat: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	readFile: fsMocks.readFile,
	stat: fsMocks.stat,
}));

import { getWorkspaceChangesSinceBaseRef } from "../../../src/workspace/get-workspace-changes";

const REPO_ROOT = "/tmp/worktree";

interface GitFixture {
	mergeBase?: string | null;
	baseTip?: string | null;
	trackedByRef?: Record<string, string>;
	untracked?: string;
}

function installGitFixture(fixture: GitFixture): void {
	gitMocks.getGitStdout.mockImplementation(async (args: string[]) => {
		const [command] = args;
		if (command === "rev-parse" && args[1] === "--show-toplevel") {
			return REPO_ROOT;
		}
		if (command === "merge-base") {
			if (!fixture.mergeBase) {
				throw new Error("no merge base");
			}
			return fixture.mergeBase;
		}
		if (command === "rev-parse" && args[1] === "--verify") {
			const revision = args[2] ?? "";
			if (revision.endsWith("^{commit}")) {
				if (!fixture.baseTip) {
					throw new Error("unknown revision");
				}
				return fixture.baseTip;
			}
			return revision;
		}
		if (command === "ls-files") {
			return fixture.untracked ?? "";
		}
		if (command === "diff" && args[1] === "--name-status") {
			const fromRef = args[3] ?? "";
			return fixture.trackedByRef?.[fromRef] ?? "";
		}
		if (command === "diff" && args[1] === "--numstat") {
			return "3\t1\tsrc/a.ts";
		}
		if (command === "show") {
			return "old contents\n";
		}
		throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
	});
}

describe("getWorkspaceChangesSinceBaseRef", () => {
	beforeEach(() => {
		gitMocks.getGitStdout.mockReset();
		fsMocks.readFile.mockReset();
		fsMocks.stat.mockReset();
		fsMocks.readFile.mockResolvedValue("new contents\n");
		fsMocks.stat.mockResolvedValue({ size: 13, mtimeMs: 1, ctimeMs: 1 });
	});

	it("anchors the diff at the fork point so committed turns are still reported", async () => {
		installGitFixture({
			mergeBase: "fork-point",
			trackedByRef: {
				HEAD: "",
				"fork-point": "M\tsrc/a.ts",
			},
		});

		const response = await getWorkspaceChangesSinceBaseRef({
			cwd: REPO_ROOT,
			baseRef: "main",
		});

		expect(response.files.map((file) => file.path)).toEqual(["src/a.ts"]);
		expect(response.files[0]).toMatchObject({
			status: "modified",
			additions: 3,
			deletions: 1,
			oldText: "old contents\n",
			newText: "new contents\n",
		});
		expect(gitMocks.getGitStdout).not.toHaveBeenCalledWith(
			["diff", "--name-status", "--find-renames", "HEAD", "--"],
			REPO_ROOT,
			expect.anything(),
		);
	});

	it("falls back to the base ref tip when there is no common ancestor", async () => {
		installGitFixture({
			mergeBase: null,
			baseTip: "base-tip",
			trackedByRef: {
				"base-tip": "A\tsrc/new.ts",
			},
		});

		const response = await getWorkspaceChangesSinceBaseRef({
			cwd: REPO_ROOT,
			baseRef: "main",
		});

		expect(response.files.map((file) => file.path)).toEqual(["src/new.ts"]);
		expect(response.files[0]?.oldText).toBeNull();
	});

	it("reuses the cached response while the worktree state is unchanged", async () => {
		installGitFixture({
			mergeBase: "fork-point",
			trackedByRef: {
				"fork-point": "M\tsrc/a.ts",
			},
		});

		const first = await getWorkspaceChangesSinceBaseRef({ cwd: REPO_ROOT, baseRef: "main" });
		const showCallsAfterFirst = gitMocks.getGitStdout.mock.calls.filter((call) => call[0][0] === "show").length;
		const second = await getWorkspaceChangesSinceBaseRef({ cwd: REPO_ROOT, baseRef: "main" });

		expect(second).toBe(first);
		expect(gitMocks.getGitStdout.mock.calls.filter((call) => call[0][0] === "show")).toHaveLength(
			showCallsAfterFirst,
		);
	});

	it("rejects a blank base ref", async () => {
		installGitFixture({ mergeBase: "fork-point" });

		await expect(getWorkspaceChangesSinceBaseRef({ cwd: REPO_ROOT, baseRef: "  " })).rejects.toThrow(
			"Task base branch is required",
		);
	});
});
