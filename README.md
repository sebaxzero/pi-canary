# pi-canary

A [pi](https://pi.dev) extension that silently verifies the agent's context awareness on every turn using hidden canary tokens.

Before answering your message, the agent must locate and return N canary tokens distributed across the conversation history. The entire verification exchange is invisible: no tokens in the thinking block, no tokens in the visible response, nothing in the history the agent uses to answer you.

## Install

```bash
pi install git:github.com/sebaxzero/pi-canary.git
```

Or install project-locally (adds to `.pi/settings.json` only):

```bash
pi install git:github.com/sebaxzero/pi-canary.git -l
```

## How it works

Every time you send a message, the extension runs a hidden two-phase exchange before your question is answered:

**Phase 1 — Verify**

- N random 24-character canary tokens are generated (or reused if `VARIANT=fixed`).
- They are injected at the configured positions across the conversation history. The last token also carries a verification instruction.
- Your original question is temporarily suppressed.
- The agent is asked only to return the N tokens by name.
- The response is captured and checked. The exchange is hidden from the TUI.

**Phase 2 — Respond**

- The tokens and the verification exchange are stripped from context entirely.
- Your original question is restored.
- The agent answers normally, with no canary tokens anywhere in its view.

If verification fails, a warning notification appears in the TUI.

## Configuration

Persistent configuration lives in `extensions/canary.json`. You can ask the agent to edit it directly:

```json
{
  "COUNT": 3,
  "POSITION": "end",
  "VARIANT": "fixed",
  "FAIL_COMPACT": 0
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `COUNT` | `3` | Number of canary tokens injected per turn (`0` disables the canary check entirely) |
| `POSITION` | `end` | Where tokens are injected: `start`, `equidistant`, or `end` |
| `VARIANT` | `fixed` | `fixed` = same tokens every turn (preserves KV cache); `variant` = new tokens each turn |
| `FAIL_COMPACT` | `0` | Compact context after N consecutive failures (`0` = disabled) |

**`POSITION=end` + `VARIANT=fixed`** (the defaults) is the cache-friendly mode for local model servers: the message prefix never changes and the injected suffix is always the same tokens, so the KV cache stays warm after the first turn. Use `POSITION=equidistant` + `VARIANT=variant` for maximum coverage at the cost of cache invalidation every turn.

Changes to the JSON take effect on the next session. For live tuning within a session, use the command below.

## Command

```
/canary                    — show current phase, failure count, and config
/canary set KEY=VAL        — override config for the current session only
/canary set KEY=VAL KEY=VAL ...
```

Example: `/canary set COUNT=5 POSITION=equidistant VARIANT=variant`

## Compatibility

Works alongside [pi-loop-police](https://github.com/sebaxzero/pi-loop-police). When loop-police aborts a turn, the canary check yields gracefully and does not fire its own recovery.

## License

MIT

---

Built with [Claude](https://claude.ai).
