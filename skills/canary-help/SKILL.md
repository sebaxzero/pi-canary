---
name: canary-help
description: "Reference for pi-canary: commands, config keys, and how to persistently edit canary.json."
homepage: https://github.com/sebaxzero/pi-canary
license: MIT
---

# Canary Help

pi-canary runs a hidden pre-turn where the agent must recall N secret tokens
injected into the conversation history. Passed = proceed; failed = warning.

## Commands

| Command | What it does |
|---------|-------------|
| `/canary` | Show current status and config |
| `/canary set KEY=VAL` | Change one or more keys for this session only |

## Config keys

| Key | Default | Valid values | What it controls |
|-----|---------|-------------|-----------------|
| `COUNT` | `3` | integer > 0 | Number of canary tokens per turn |
| `POSITION` | `end` | `start` \| `equidistant` \| `end` | Where tokens are injected in context |
| `VARIANT` | `fixed` | `fixed` \| `variant` | Fixed reuses same tokens (KV-cache friendly); variant regenerates each turn |
| `FAIL_COMPACT` | `0` | integer ≥ 0 | Trigger compaction after N consecutive failures (0 = disabled) |

## Changing config

**Session only** (lost on restart):
```
/canary set COUNT=2
/canary set COUNT=2 POSITION=start VARIANT=variant
```

**Persistent** (survives restarts): edit `canary.json` in the extensions directory.

Global git install path:
```
~/.pi/agent/git/github.com/sebaxzero/pi-canary/extensions/canary.json
```

Example `canary.json`:
```json
{
  "COUNT": 2,
  "POSITION": "end",
  "VARIANT": "fixed",
  "FAIL_COMPACT": 0
}
```

Only include the keys you want to override — missing keys use the defaults above.
