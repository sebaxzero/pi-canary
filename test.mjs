// Run: node --test test.mjs
// Pure logic duplicated from extensions/canary.ts — no build step.
// positionLabel/insertIndex take `position` as a parameter here (the extension
// reads it from cfg); the math is otherwise identical.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

function generateToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function positionLabel(index, total, position) {
  if (position === "start") return "beginning of context";
  if (position === "end") return "end of context";
  // equidistant
  if (total === 1) return "end of context";
  const fraction = index / (total - 1);
  if (fraction === 0) return "beginning of context";
  if (fraction === 1) return "end of context";
  return `middle of context (~${Math.round(fraction * 100)}%)`;
}

// Mirror of the insertAt computation in the Phase-1 context hook
function insertIndex(i, count, histLen, position) {
  if (position === "start") return 0;
  if (position === "end") return histLen;
  const fraction = count === 1 ? 1 : i / (count - 1);
  return Math.round(fraction * histLen);
}

function buildVerificationInstruction(count) {
  const formatLines = Array.from({ length: count }, (_, i) => `marker-${i + 1}: <value>`);
  return [
    `Recall check — list the ${count} marker${count === 1 ? "" : "s"} from this conversation:`,
    ...formatLines,
  ].join("\n");
}

// ---------------------------------------------------------------------------

describe("generateToken", () => {
  test("32 hex chars, no dashes", () => {
    assert.match(generateToken(), /^[0-9a-f]{32}$/);
  });

  test("unique across calls", () => {
    assert.notEqual(generateToken(), generateToken());
  });
});

describe("positionLabel", () => {
  test("start / end are fixed labels", () => {
    assert.equal(positionLabel(1, 3, "start"), "beginning of context");
    assert.equal(positionLabel(1, 3, "end"), "end of context");
  });

  test("equidistant: first, middle, last of 3", () => {
    assert.equal(positionLabel(0, 3, "equidistant"), "beginning of context");
    assert.equal(positionLabel(1, 3, "equidistant"), "middle of context (~50%)");
    assert.equal(positionLabel(2, 3, "equidistant"), "end of context");
  });

  test("equidistant with a single token → end", () => {
    assert.equal(positionLabel(0, 1, "equidistant"), "end of context");
  });
});

describe("insertIndex", () => {
  test("start always 0, end always histLen", () => {
    assert.equal(insertIndex(2, 3, 10, "start"), 0);
    assert.equal(insertIndex(0, 3, 10, "end"), 10);
  });

  test("equidistant spreads 3 tokens over 10 messages → 0, 5, 10", () => {
    const idx = [0, 1, 2].map((i) => insertIndex(i, 3, 10, "equidistant"));
    assert.deepEqual(idx, [0, 5, 10]);
  });

  test("equidistant single token lands at the end", () => {
    assert.equal(insertIndex(0, 1, 10, "equidistant"), 10);
  });
});

describe("buildVerificationInstruction", () => {
  test("one line per marker plus the header", () => {
    const lines = buildVerificationInstruction(3).split("\n");
    assert.equal(lines.length, 4);
    assert.equal(lines[3], "marker-3: <value>");
  });

  test("singular form for a single marker", () => {
    const s = buildVerificationInstruction(1);
    assert.ok(s.includes("1 marker from"));
    assert.ok(!s.includes("markers"));
  });
});

describe("token recall check (message_end logic)", () => {
  const missing = (tokens, fullText) => tokens.filter((t) => !fullText.includes(t));

  test("all tokens present → pass", () => {
    const tokens = [generateToken(), generateToken()];
    assert.deepEqual(missing(tokens, `marker-1: ${tokens[0]}\nmarker-2: ${tokens[1]}`), []);
  });

  test("one token absent → that token reported missing", () => {
    const tokens = [generateToken(), generateToken()];
    assert.deepEqual(missing(tokens, `marker-1: ${tokens[0]}`), [tokens[1]]);
  });
});
