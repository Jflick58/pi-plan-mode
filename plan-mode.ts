/**
 * Plan Mode Extension
 *
 * Toggleable read-only mode that blocks write/edit tools.
 * Smart bash filtering with whitelist and AI review.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";

export const SAFE_COMMAND_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*ls\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*wc\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*git\s+(status|log|diff|show|branch)\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*which\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*date\b/,
];

export const MUTATING_GIT_COMMANDS: RegExp[] = [
	/^\s*git\s+commit/,
	/^\s*git\s+push/,
	/^\s*git\s+pull/,
	/^\s*git\s+merge/,
	/^\s*git\s+rebase/,
	/^\s*git\s+reset/,
	/^\s*git\s+cherry-pick/,
	/^\s*git\s+branch\s+-D/,
	/^\s*git\s+branch\s+-d/,
	/^\s*git\s+tag\s+-d/,
];

// Block dangerous shell constructs (but allow pipes for safe command chaining)
export const UNSAFE_SHELL_CHARS = /[;&`\n]/;
export const REDIRECT_PATTERN = />{1,2}/;

// Patterns for unsafe pipe targets
const UNSAFE_PIPE_PATTERNS: RegExp[] = [
	/\|\s*rm\b/,
	/\|\s*xargs.*rm\b/,
	/\|\s*sudo\b/,
	/\|\s*chmod\b/,
	/\|\s*chown\b/,
	/\|\s*mv\b/,
	/\|\s*cp\b/,
	/\|\s*wget\b/,
	/\|\s*curl\b/,
];

function hasUnsafePipe(command: string): boolean {
	return UNSAFE_PIPE_PATTERNS.some((p) => p.test(command));
}

export function isWhitelisted(command: string): boolean {
	const trimmed = command.trim().replace(/\\\n\s*/g, "").replace(/\n\s*/g, " ");
	if (UNSAFE_SHELL_CHARS.test(trimmed)) return false;
	if (REDIRECT_PATTERN.test(trimmed)) return false;
	if (hasUnsafePipe(trimmed)) return false;
	return SAFE_COMMAND_PATTERNS.some((p) => p.test(trimmed));
}

function getBashOverride(entries: any[], command: string): boolean {
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "plan-mode-bash-override") {
			if (entry.data?.command === command) return true;
		}
	}
	return false;
}

// Tools the agent is limited to while plan mode is active.
export const PLAN_MODE_TOOLS = ["read", "bash"];
// Safe fallback used when no snapshot of the pre-plan-mode active set exists
// (e.g. resuming a session persisted before snapshots were recorded). Restores
// core read/write access without re-declaring codemode/deferred tools.
export const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

/**
 * Compute the active tool set to restore when leaving plan mode.
 *
 * Starts from the snapshot captured on entry (or NORMAL_MODE_TOOLS as a safe
 * fallback) and merges back any tools that became active during plan mode, such
 * as tools loaded by tool_search. Never consults getAllTools(), so it cannot
 * re-activate codemode/deferred tools that Pi deliberately keeps inactive.
 */
export function restoredToolSet(
	savedActiveTools: string[] | undefined,
	currentActiveTools: string[],
): string[] {
	const base = savedActiveTools ?? NORMAL_MODE_TOOLS;
	const mergedFromCurrent = currentActiveTools.filter((name) => !PLAN_MODE_TOOLS.includes(name));
	return [...new Set([...base, ...mergedFromCurrent])];
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	// Snapshot of the active tool set captured when plan mode is entered, so it can
	// be restored on exit. undefined when plan mode is off / not yet entered.
	let savedActiveTools: string[] | undefined;

	function enablePlanModeTools(): void {
		// Snapshot the real active set the first time we enter plan mode. Do not
		// overwrite an existing snapshot (e.g. one restored from a persisted session
		// entry on resume).
		if (savedActiveTools === undefined) {
			savedActiveTools = pi.getActiveTools();
		}
		pi.setActiveTools(PLAN_MODE_TOOLS);
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(restoredToolSet(savedActiveTools, pi.getActiveTools()));
		savedActiveTools = undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus("plan", ctx.ui.theme.fg("warning", "⚠️ planning"));
		} else {
			ctx.ui.setStatus("plan", undefined);
		}
	}

	function persistState(ctx: ExtensionContext): void {
		pi.appendEntry("plan-mode", {
			active: planModeEnabled,
			// Persist the snapshot so a resumed/forked session can restore the
			// pre-plan-mode tool set without falling back to getAllTools().
			savedActiveTools,
			timestamp: new Date().toISOString(),
		});
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (blocks write/edit tools)",
		handler: async (_args, ctx) => {
			planModeEnabled = !planModeEnabled;

			if (planModeEnabled) {
				enablePlanModeTools();
				ctx.ui.notify("✅ Plan mode enabled - writes blocked", "info");
			} else {
				restoreNormalModeTools();
				ctx.ui.notify("✅ Plan mode disabled - writes enabled", "info");
			}

			updateStatus(ctx);
			persistState(ctx);
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// Only act when plan mode is active. When it is off we leave the active tool
		// set exactly as Pi configured it. The previous implementation called
		// pi.setActiveTools(pi.getAllTools()) here on every prompt, which force-
		// declared codemode/deferred tools (MCP servers, inactive extension tools)
		// that Pi deliberately keeps inactive — ballooning the first turn from ~45K
		// to ~385K tokens. Tool activation now happens only on the plan-mode
		// transition (command handler) and on resume (session_start).
		if (!planModeEnabled) return;

		const instructions = `[PLAN MODE ACTIVE]

You are in plan mode. This is a PLANNING PHASE only.

Available tools:
- read: Read files to understand the codebase
- bash: Run commands for exploration (safe commands allowed, others reviewed)

Note: write and edit tools are disabled in plan mode.

Help the user plan what needs to be done:
- Explore the codebase
- Discuss the approach
- Identify files that need changes
- When ready, remind the user to run /plan to exit plan mode`;

		return {
			systemPrompt: _event.systemPrompt + "\n\n" + instructions,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const planEntries = entries.filter(
			(e) => e.type === "custom" && e.customType === "plan-mode",
		);
		const lastEntry = planEntries.length > 0 ? planEntries[planEntries.length - 1] : null;

		if (lastEntry && "data" in lastEntry && (lastEntry as any).data?.active === true) {
			planModeEnabled = true;
			const saved = (lastEntry as any).data?.savedActiveTools;
			savedActiveTools = Array.isArray(saved) ? saved : undefined;
			// Re-enforce the read/bash restriction for the resumed session. The
			// snapshot comes only from the persisted entry — we must NOT snapshot the
			// current active set here, because on resume it is already the restricted
			// read/bash set, not the real pre-plan-mode tools. When no snapshot was
			// persisted (sessions from an older version), savedActiveTools stays
			// undefined so leaving plan mode falls back to NORMAL_MODE_TOOLS without
			// ever calling getAllTools().
			pi.setActiveTools(PLAN_MODE_TOOLS);
			updateStatus(ctx);
			ctx.ui.notify("i️ Plan mode restored", "info");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;

		// Block write/edit tools
		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true,
				reason: "Plan mode active. Use /plan to enable write/edit tools.",
			};
		}

		if (event.toolName === "bash") {
			const command = (event.input as any)?.command || "";

			const entries = ctx.sessionManager.getEntries();
			if (getBashOverride(entries, command)) return;

			if (MUTATING_GIT_COMMANDS.some((p) => p.test(command))) {
				return {
					block: true,
					reason: "Plan mode: mutating git commands are not allowed.",
				};
			}

			// Block commands with shell redirects (>, >>) - these write to files
			if (REDIRECT_PATTERN.test(command)) {
				return {
					block: true,
					reason: "Plan mode: file redirects are not allowed.",
				};
			}

			if (isWhitelisted(command)) return;

			try {
				const currentModel = ctx.model;
				if (!currentModel) {
					return {
						block: true,
						reason: "Plan mode: cannot review command (no model available).",
					};
				}

				const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(currentModel);
				if (!authResult.ok) {
					return {
						block: true,
						reason: "Plan mode: cannot review command (auth failed).",
					};
				}

				const response = await completeSimple(
					currentModel,
					{
						messages: [
							{
								role: "user",
								content: [
									{
										type: "text",
										text:
											"Is this bash command EXPLORATORY (read-only, safe in plan mode) or MUTATING (writes, deletes, or changes state)?\n\n" +
											`$ ${command}\n\nRespond with a single word: EXPLORATORY or MUTATING`,
									},
								],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey: authResult.apiKey, headers: authResult.headers, maxTokens: 256 },
				);

				const text = response.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join(" ")
					.toLowerCase();

				if (text.includes("mutating")) {
					const allowed = await ctx.ui.confirm(
						"Plan mode: command blocked",
						`This command would mutate state:\n\n  $ ${command}\n\nAllow anyway?`,
					);

					if (allowed) {
						pi.appendEntry("plan-mode-bash-override", { command, timestamp: Date.now() });
						return;
					}

					return {
						block: true,
						reason: "Plan mode: command would mutate state. Use /plan to exit plan mode.",
					};
				}

				return;
			} catch (error: any) {
				console.error(`Plan mode AI review failed:`, error);

				const allowed = await ctx.ui.confirm(
					"Plan mode: AI review failed",
					`Could not review command due to error:\n\n  ${error.message}\n\n  $ ${command}\n\nAllow anyway?`,
				);

				if (allowed) {
					pi.appendEntry("plan-mode-bash-override", { command, timestamp: Date.now() });
					return;
				}

				return {
					block: true,
					reason: "Plan mode: AI review failed. Command blocked for safety.",
				};
			}
		}
	});
}
