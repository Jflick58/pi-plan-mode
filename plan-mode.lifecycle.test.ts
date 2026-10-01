/**
 * Lifecycle tests for the plan-mode extension's active-tool management.
 *
 * These drive the extension against a mock ExtensionAPI to prove the bug fix:
 * when plan mode is OFF the extension never touches the active tool set (and
 * never calls getAllTools()), and entering/leaving plan mode snapshots and
 * restores the active set correctly — including on resume from a persisted
 * session entry.
 */

import { describe, it, expect, beforeEach } from "vitest";
import planModeExtension, { PLAN_MODE_TOOLS, NORMAL_MODE_TOOLS } from "./plan-mode.js";

interface PersistedEntry {
	type: "custom";
	customType: string;
	data: any;
}

function makeHarness(initialActive: string[]) {
	let active = [...initialActive];
	const setActiveToolsCalls: string[][] = [];
	let getAllToolsCalls = 0;
	const entries: PersistedEntry[] = [];
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	let command: { handler: (args: any, ctx: any) => Promise<void> | void } | undefined;

	const pi: any = {
		registerCommand: (_name: string, opts: any) => {
			command = opts;
		},
		registerFlag: () => {},
		registerShortcut: () => {},
		getFlag: () => undefined,
		on: (event: string, handler: (event: any, ctx: any) => any) => {
			(handlers[event] ||= []).push(handler);
			return () => {};
		},
		appendEntry: (customType: string, data: any) => {
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
			setActiveToolsCalls.push([...names]);
		},
		// If this is ever called while plan mode is off, the bug is back.
		getAllTools: () => {
			getAllToolsCalls++;
			return active.map((name) => ({ name, exposure: "direct" }));
		},
	};

	const ctx: any = {
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_level: string, s: string) => s },
		},
		sessionManager: { getEntries: () => entries },
	};

	planModeExtension(pi);

	return {
		ctx,
		entries,
		get active() {
			return active;
		},
		setActive: (names: string[]) => {
			active = [...names];
		},
		get setActiveToolsCalls() {
			return setActiveToolsCalls;
		},
		get lastSetActiveTools() {
			return setActiveToolsCalls[setActiveToolsCalls.length - 1];
		},
		get getAllToolsCalls() {
			return getAllToolsCalls;
		},
		fireBeforeAgentStart: () =>
			Promise.all((handlers["before_agent_start"] || []).map((h) => h({ systemPrompt: "SYS" }, ctx))),
		fireSessionStart: () => Promise.all((handlers["session_start"] || []).map((h) => h({}, ctx))),
		toggle: () => command!.handler(null, ctx),
	};
}

describe("plan-mode active-tool lifecycle", () => {
	const ORIGINAL = ["read", "bash", "edit", "write", "TaskCreate", "Agent"];

	describe("plan mode OFF (the bug)", () => {
		let h: ReturnType<typeof makeHarness>;
		beforeEach(() => {
			h = makeHarness(ORIGINAL);
		});

		it("before_agent_start does not touch the active tool set", async () => {
			await h.fireBeforeAgentStart();
			expect(h.setActiveToolsCalls).toHaveLength(0);
			expect(h.active).toEqual(ORIGINAL);
		});

		it("before_agent_start never calls getAllTools()", async () => {
			await h.fireBeforeAgentStart();
			expect(h.getAllToolsCalls).toBe(0);
		});

		it("session_start with no plan-mode entry leaves tools untouched", async () => {
			await h.fireSessionStart();
			expect(h.setActiveToolsCalls).toHaveLength(0);
			expect(h.getAllToolsCalls).toBe(0);
			expect(h.active).toEqual(ORIGINAL);
		});
	});

	describe("toggle on -> off", () => {
		it("restricts to read/bash on enable, restores the snapshot on disable", async () => {
			const h = makeHarness(ORIGINAL);

			await h.toggle(); // ON
			expect(h.lastSetActiveTools).toEqual(PLAN_MODE_TOOLS);
			expect(h.active).toEqual(PLAN_MODE_TOOLS);

			await h.toggle(); // OFF
			expect(h.active).toEqual(ORIGINAL);
			expect(h.getAllToolsCalls).toBe(0);
		});

		it("merges tools that became active mid-plan (e.g. tool_search loads)", async () => {
			const h = makeHarness(ORIGINAL);

			await h.toggle(); // ON -> read/bash
			// Simulate tool_search loading a tool while in plan mode.
			h.setActive([...h.active, "loaded_by_tool_search"]);

			await h.toggle(); // OFF
			expect(h.active).toEqual([...ORIGINAL, "loaded_by_tool_search"]);
			expect(h.getAllToolsCalls).toBe(0);
		});

		it("persists the snapshot in the plan-mode entry when enabling", async () => {
			const h = makeHarness(ORIGINAL);
			await h.toggle(); // ON
			const entry = h.entries.filter((e) => e.customType === "plan-mode").pop();
			expect(entry?.data.active).toBe(true);
			expect(entry?.data.savedActiveTools).toEqual(ORIGINAL);
		});
	});

	describe("resume from persisted entry", () => {
		it("restores the snapshot and re-enforces read/bash, then restores on disable", async () => {
			// On resume Pi has already restored the restricted active set.
			const h = makeHarness([...PLAN_MODE_TOOLS]);
			h.entries.push({
				type: "custom",
				customType: "plan-mode",
				data: { active: true, savedActiveTools: ORIGINAL },
			});

			await h.fireSessionStart();
			expect(h.lastSetActiveTools).toEqual(PLAN_MODE_TOOLS); // enforced
			expect(h.getAllToolsCalls).toBe(0);

			await h.toggle(); // OFF -> restore the persisted snapshot
			expect(h.active).toEqual(ORIGINAL);
			expect(h.getAllToolsCalls).toBe(0);
		});

		it("falls back to NORMAL_MODE_TOOLS (no getAllTools) when snapshot is missing", async () => {
			// Session persisted by an older version: active=true, no savedActiveTools.
			const h = makeHarness([...PLAN_MODE_TOOLS]);
			h.entries.push({
				type: "custom",
				customType: "plan-mode",
				data: { active: true },
			});

			await h.fireSessionStart();
			expect(h.lastSetActiveTools).toEqual(PLAN_MODE_TOOLS);

			await h.toggle(); // OFF
			expect(h.active).toEqual(NORMAL_MODE_TOOLS);
			expect(h.active.some((t) => t.startsWith("mcp__"))).toBe(false);
			expect(h.getAllToolsCalls).toBe(0);
		});
	});
});
