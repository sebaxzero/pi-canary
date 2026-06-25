/**
 * Canary Extension
 *
 * Runs a hidden pre-turn where the agent must return N canary tokens distributed
 * across the conversation history. The verification is invisible to the user:
 * tokens never appear in the thinking block, visible responses, or final answer.
 *
 * Flow per user turn:
 *   1. [VERIFY] Hidden LLM call — tokens visible, original question suppressed.
 *      Agent returns tokens only. Response hidden.
 *   2. [RESPOND] Real LLM call — clean context, no tokens anywhere, agent answers normally.
 *
 * POSITION=end + VARIANT=fixed (defaults) preserves KV cache on local model servers:
 * the prefix never changes and the injected suffix is always the same tokens.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Config lives next to the extension file: ./extensions/canary.json
// Auto-created on first load with defaults; travels with the extension.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXT_DIR, "canary.json");

const DEFAULTS = {
  COUNT: 3,
  POSITION: "end" as const,
  VARIANT: "fixed" as const,
  FAIL_COMPACT: 0,
};

// Loaded from sibling JSON at startup; /set overrides for the current session only
const cfg: typeof DEFAULTS & { COUNT: number; FAIL_COMPACT: number } = (() => {
  // Ensure config file exists with defaults
  if (!existsSync(CONFIG_PATH)) {
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + "\n", "utf-8");
    } catch {
      // If we can't write (e.g. permissions), just use defaults in memory
    }
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULTS };
  }
})();

// --- Token generation ---

const TOKEN_LENGTH = 24;
const TOKEN_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateToken(): string {
  const arr = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => TOKEN_CHARSET[b % TOKEN_CHARSET.length]).join("");
}

// --- Message builders ---

function positionLabel(index: number, total: number): string {
  if (cfg.POSITION === "start") return "beginning of context";
  if (cfg.POSITION === "end") return "end of context";
  // equidistant
  if (total === 1) return "end of context";
  const fraction = index / (total - 1);
  if (fraction === 0) return "beginning of context";
  if (fraction === 1) return "end of context";
  return `middle of context (~${Math.round(fraction * 100)}%)`;
}

function buildAnchorContent(token: string, index: number, total: number): string {
  return `[CANARY — TOKEN_${index + 1} of ${total} — ${positionLabel(index, total)}]\n${token}`;
}

function buildVerificationInstruction(count: number): string {
  const formatLines = Array.from({ length: count }, (_, i) => `TOKEN_${i + 1}: <value>`);
  return [
    "═══════════════════════════════════════════════════════════",
    "⚠️  CANARY CHECK ⚠️",
    "═══════════════════════════════════════════════════════════",
    "",
    `Return ONLY the ${count} canary token${count === 1 ? "" : "s"} below. Do not say anything else.`,
    ...formatLines,
    "═══════════════════════════════════════════════════════════",
  ].join("\n");
}

// --- Extension ---

type Phase = "idle" | "verifying" | "responding";

export default function (pi: ExtensionAPI) {
  let phase: Phase = "idle";
  let currentTokens: string[] | null = null;
  // Reused across turns in fixed mode; null forces regeneration
  let fixedTokens: string[] | null = null;
  // Saved before Phase 1 replaces the last user message; restored in Phase 2
  // if the model refused/errored so the Jinja2 template still sees a real user query.
  let originalUserMessage: string | null = null;
  let consecutiveFailures = 0;
  // Guard against double-injection if context fires twice before message_end (retries)
  let verifyContextSent = false;
  // Timestamp of the hidden verification assistant message — used to filter it in Phase 2
  let verifyResponseTimestamp: number | null = null;

  pi.on("before_agent_start", (_event, _ctx) => {
    // COUNT=0 disables the canary check entirely
    if (cfg.COUNT === 0) {
      phase = "idle";
      currentTokens = null;
      return;
    }
    if (cfg.VARIANT === "fixed") {
      if (!fixedTokens || fixedTokens.length !== cfg.COUNT) {
        fixedTokens = Array.from({ length: cfg.COUNT }, generateToken);
      }
      currentTokens = fixedTokens;
    } else {
      currentTokens = Array.from({ length: cfg.COUNT }, generateToken);
    }
    phase = "verifying";
    verifyContextSent = false;
    originalUserMessage = null;
  });

  pi.on("context", (event, _ctx) => {
    // --- Phase 1: build verification-only context ---
    if (phase === "verifying" && currentTokens && !verifyContextSent) {
      verifyContextSent = true;
      const messages = [...event.messages];

      // Replace the original user question with a neutral prompt so the agent focuses
      // only on the canary check. We keep the user role (replacing content, not the
      // message) because some providers (e.g. llama-server) use Jinja2 chat templates
      // that require a user message at the end of the conversation — removing it causes
      // template parsing to fail with "No user query found in messages." The original
      // question remains in session history and reappears in Phase 2.
      if (messages.length > 0 && (messages[messages.length - 1] as any).role === "user") {
        const lastMsg = messages[messages.length - 1] as any;
        // Save the original content so Phase 2 can restore it if the model refused/errored
        originalUserMessage =
          typeof lastMsg.content === "string"
            ? lastMsg.content
            : Array.isArray(lastMsg.content)
              ? lastMsg.content
                  .filter((c: any) => c?.type === "text")
                  .map((c: any) => c.text)
                  .join("\n")
              : null;
        if (typeof lastMsg.content === "string") {
          lastMsg.content = "Please return the canary tokens.";
        } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
          lastMsg.content = [{ type: "text", text: "Please return the canary tokens." }];
        }
      }

      const histLen = messages.length;
      const count = currentTokens.length;

      const injections = currentTokens
        .map((token, i) => {
          let insertAt: number;
          if (cfg.POSITION === "start") insertAt = 0;
          else if (cfg.POSITION === "end") insertAt = histLen;
          else {
            // equidistant
            const fraction = count === 1 ? 1 : i / (count - 1);
            insertAt = Math.round(fraction * histLen);
          }
          return { insertAt, token, i, isLast: i === count - 1 };
        })
        .reverse(); // reverse so splices don't shift earlier indices

      for (const { insertAt, token, i, isLast } of injections) {
        const content = isLast
          ? buildAnchorContent(token, i, count) + "\n\n" + buildVerificationInstruction(count)
          : buildAnchorContent(token, i, count);

        messages.splice(insertAt, 0, {
          role: "custom",
          customType: "canary",
          content,
          display: false,
          timestamp: Date.now(),
        } as any);
      }

      return { messages };
    }

    // --- Phase 2: strip the hidden verification exchange ---
    if (phase === "responding") {
      let messages = event.messages.filter(
        (m: any) => m.customType !== "canary" &&
                    m.timestamp !== verifyResponseTimestamp
      );
      if (messages.length !== event.messages.length) {
        // If the model refused/errored in Phase 1, the last user message is still
        // the canary prompt ("Please return the canary tokens."). Restore the original
        // so the Jinja2 chat template sees a real user query.
        if (
          originalUserMessage &&
          messages.length > 0 &&
          (messages[messages.length - 1] as any).role === "user"
        ) {
          const lastMsg = messages[messages.length - 1] as any;
          const canaryPrompt = "Please return the canary tokens.";
          const lastContent = typeof lastMsg.content === "string" ? lastMsg.content : "";
          if (lastContent === canaryPrompt) {
            lastMsg.content = originalUserMessage;
          }
        }
        return { messages };
      }
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    // --- Phase 2 completion: reset and let the response through ---
    if (phase === "responding") {
      phase = "idle";
      return;
    }

    if (phase !== "verifying") return;

    const tokens = currentTokens;
    currentTokens = null;

    // Skip aborted or errored turns
    const stopReason = (event.message as any).stopReason;
    if (stopReason === "aborted" || stopReason === "error") {
      phase = "idle";
      return;
    }

    // Yield to loop-police
    const rawContent = event.message.content;
    if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (
          part && typeof part === "object" && "type" in part &&
          part.type === "thinking" && "thinking" in part &&
          typeof part.thinking === "string" &&
          (part.thinking.includes("[THINKING LOOP") || part.thinking.includes("[SEMANTIC LOOP"))
        ) {
          phase = "idle";
          return;
        }
      }
    }

    if (!tokens) { phase = "idle"; return; }

    // Extract text from the verification response
    const textParts: string[] = [];
    if (typeof rawContent === "string") {
      textParts.push(rawContent);
    } else if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
    }
    const fullText = textParts.join("\n");

    const missing = tokens
      .map((t, i) => ({ label: `TOKEN_${i + 1}`, value: t, found: fullText.includes(t) }))
      .filter((x) => !x.found);

    // Replace the verification response with an empty assistant message.
    // AssistantMessage.role must stay "assistant" — no display flag exists on this type,
    // but content: [] renders as nothing in TUI. Filtered from Phase 2 context by timestamp.
    verifyResponseTimestamp = (event.message as any).timestamp ?? null;
    const emptyResponse = { ...event.message, content: [] } as any;

    if (missing.length === 0) {
      // Verification passed — proceed to Phase 2
      consecutiveFailures = 0;
      phase = "responding";
      pi.sendMessage(
        { customType: "canary", content: "✓", display: false },
        { triggerTurn: true, deliverAs: "steer" }
      );
      return { message: emptyResponse };
    }

    // Verification failed
    consecutiveFailures++;

    if (cfg.FAIL_COMPACT > 0 && consecutiveFailures >= cfg.FAIL_COMPACT) {
      consecutiveFailures = 0;
      phase = "idle";
      ctx.ui.notify(
        `Canary: ${cfg.FAIL_COMPACT} consecutive failure(s) — triggering compaction`,
        "warning"
      );
      ctx.compact({
        customInstructions: `The agent failed to recall canary tokens ${cfg.FAIL_COMPACT} time(s) in a row. After compaction, return all canary tokens before doing anything else.`,
      });
      return { message: emptyResponse };
    }

    // Proceed to Phase 2 despite failure (user still gets a response)
    ctx.ui.notify("⚠️ Canary check failed — context may be degraded", "warning");
    phase = "responding";
    pi.sendMessage(
      { customType: "canary", content: "⚠️", display: false },
      { triggerTurn: true, deliverAs: "steer" }
    );
    return { message: emptyResponse };
  });

  pi.registerCommand("canary", {
    description: "Show status; /canary set KEY=VAL [KEY=VAL ...]",
    handler: (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (trimmed.startsWith("set ")) {
        const results: string[] = [];
        for (const pair of trimmed.slice(4).trim().split(/\s+/)) {
          const eq = pair.indexOf("=");
          const key = pair.slice(0, eq).toUpperCase();
          const val = pair.slice(eq + 1);
          if (eq > 0 && val !== "") {
            if (key === "COUNT") {
              const n = parseInt(val, 10);
              if (n >= 0) { cfg.COUNT = n; fixedTokens = null; results.push(`COUNT=${cfg.COUNT}`); }
              else results.push(`invalid COUNT: ${val}`);
            } else if (key === "POSITION") {
              if (val === "start" || val === "equidistant" || val === "end") {
                cfg.POSITION = val; results.push(`POSITION=${cfg.POSITION}`);
              } else results.push(`invalid POSITION: ${val} (start|equidistant|end)`);
            } else if (key === "VARIANT") {
              if (val === "fixed" || val === "variant") {
                cfg.VARIANT = val; if (val === "variant") fixedTokens = null;
                results.push(`VARIANT=${cfg.VARIANT}`);
              } else results.push(`invalid VARIANT: ${val} (fixed|variant)`);
            } else if (key === "FAIL_COMPACT") {
              const n = parseInt(val, 10);
              if (n >= 0) { cfg.FAIL_COMPACT = n; results.push(`FAIL_COMPACT=${cfg.FAIL_COMPACT}`); }
              else results.push(`invalid FAIL_COMPACT: ${val}`);
            } else {
              results.push(`unknown: ${key}`);
            }
          }
        }
        ctx.ui.notify(`Canary: ${results.join(", ")}`, "info");
        return;
      }

      ctx.ui.notify(
        [
          "Canary status",
          `  phase:                 ${phase}`,
          `  tokens per turn:       ${cfg.COUNT}`,
          `  position:              ${cfg.POSITION}`,
          `  variant:               ${cfg.VARIANT}`,
          `  compact after N fails: ${cfg.FAIL_COMPACT === 0 ? "disabled" : cfg.FAIL_COMPACT}`,
          `  consecutive failures:  ${consecutiveFailures}`,
          "",
          "  config (/set = session only; edit canary.json for persistence):",
          `    COUNT=${cfg.COUNT}`,
          `    POSITION=${cfg.POSITION}`,
          `    VARIANT=${cfg.VARIANT}`,
          `    FAIL_COMPACT=${cfg.FAIL_COMPACT}`,
        ].join("\n"),
        "info"
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify(`Canary loaded — ${cfg.COUNT} token(s), position=${cfg.POSITION}, variant=${cfg.VARIANT}`, "info");
    }
  });
}
