/**
 * Tests for plan-mode extension whitelist functionality.
 * 
 * These tests document the current bugs where safe commands are incorrectly blocked.
 */

import { describe, it, expect } from "vitest";
import { isWhitelisted, restoredToolSet, NORMAL_MODE_TOOLS, PLAN_MODE_TOOLS } from "./plan-mode.js";

describe("plan-mode whitelist", () => {
	describe("commands without trailing space", () => {
		it("should whitelist ls alone", () => {
			expect(isWhitelisted("ls")).toBe(true);
		});

		it("should whitelist git log", () => {
			expect(isWhitelisted("git log")).toBe(true);
		});

		it("should whitelist git status", () => {
			expect(isWhitelisted("git status")).toBe(true);
		});

		it("should whitelist git diff", () => {
			expect(isWhitelisted("git diff")).toBe(true);
		});

		it("should whitelist git show", () => {
			expect(isWhitelisted("git show")).toBe(true);
		});

		it("should whitelist git branch", () => {
			expect(isWhitelisted("git branch")).toBe(true);
		});
	});

	describe("safe pipe operations", () => {
		it("should whitelist ls piped to grep", () => {
			expect(isWhitelisted("ls -la | grep test")).toBe(true);
		});

		it("should whitelist find piped to wc", () => {
			expect(isWhitelisted("find . -name '*.ts' | wc -l")).toBe(true);
		});

		it("should whitelist cat piped to grep", () => {
			expect(isWhitelisted("cat file.ts | grep pattern")).toBe(true);
		});

		it("should whitelist find piped to grep", () => {
			expect(isWhitelisted("find . -type f | grep .ts$")).toBe(true);
		});
	});

	describe("commands that should work (baseline)", () => {
		it("should whitelist pwd", () => {
			expect(isWhitelisted("pwd")).toBe(true);
		});

		it("should whitelist env", () => {
			expect(isWhitelisted("env")).toBe(true);
		});

		it("should whitelist ls with flags", () => {
			expect(isWhitelisted("ls -la")).toBe(true);
		});

		it("should whitelist grep with arguments", () => {
			expect(isWhitelisted("grep pattern file.ts")).toBe(true);
		});

		it("should whitelist cat with file", () => {
			expect(isWhitelisted("cat file.ts")).toBe(true);
		});
	});

	describe("restoredToolSet (leaving plan mode)", () => {
		it("restores the exact snapshot captured on entry", () => {
			const snapshot = ["read", "bash", "edit", "write", "task_create"];
			// While in plan mode only read/bash were active.
			expect(restoredToolSet(snapshot, PLAN_MODE_TOOLS)).toEqual(snapshot);
		});

		it("merges tools that became active during plan mode (e.g. tool_search loads)", () => {
			const snapshot = ["read", "bash", "edit", "write"];
			const current = ["read", "bash", "mcp__tool-gateway__some_tool"];
			expect(restoredToolSet(snapshot, current)).toEqual([
				"read",
				"bash",
				"edit",
				"write",
				"mcp__tool-gateway__some_tool",
			]);
		});

		it("falls back to NORMAL_MODE_TOOLS when no snapshot exists", () => {
			// Resume of a session persisted before snapshots were recorded: current
			// active set is the restricted read/bash.
			expect(restoredToolSet(undefined, ["read", "bash"])).toEqual(NORMAL_MODE_TOOLS);
		});

		it("never re-adds codemode/deferred tools (no getAllTools) on fallback", () => {
			const restored = restoredToolSet(undefined, ["read", "bash"]);
			expect(restored.some((t) => t.startsWith("mcp__"))).toBe(false);
		});

		it("does not duplicate read/bash", () => {
			const restored = restoredToolSet(["read", "bash", "edit"], ["read", "bash"]);
			expect(restored.filter((t) => t === "read")).toHaveLength(1);
			expect(restored.filter((t) => t === "bash")).toHaveLength(1);
		});
	});

	describe("commands that should be blocked", () => {
		it("should block file redirects", () => {
			expect(isWhitelisted("cat file > output")).toBe(false);
		});

		it("should block append redirects", () => {
			expect(isWhitelisted("echo test >> file")).toBe(false);
		});

		it("should block command substitution", () => {
			expect(isWhitelisted("rm $(find . -name '*.log')")).toBe(false);
		});

		it("should block semicolon commands", () => {
			expect(isWhitelisted("ls; rm -rf .")).toBe(false);
		});

		it("should block unsafe pipe to rm", () => {
			// This should be blocked - piping to rm is dangerous
			expect(isWhitelisted("find . -name '*.log' | xargs rm")).toBe(false);
		});
	});
});
