# 004 — SIP real-UDP integration test flaky in full suite

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Axis** | correctness / CI reliability |
| **Status** | open |
| **Location** | `packages/kuralle-livekit-plugin-transport-sip/test/sip_signaling_udp_integration.test.ts:184` |

## What's wrong

`handles pending and established dialog flows over real UDP` passes in isolation (~66ms) but fails when the full package suite runs:

```
error: Timed out waiting for 2 messages; received 0
  at waitForMessages (...sip_signaling_udp_integration.test.ts:47:15)
(fail) ... [8013ms]
```

29 pass / 1 fail in `bun test` for the SIP transport package.

## Why it fails

The first `waitForMessages(cancelReceived, 2)` never receives SIP provisional responses — the server bind or UDP delivery is lost under suite concurrency. Likely test pollution or parallel file execution in Bun, not the debug-logging changes (SIP package diff in this session only gated `console.log` → `debug()`).

## Evidence

```bash
# Isolated — pass
cd packages/kuralle-livekit-plugin-transport-sip
bun test test/sip_signaling_udp_integration.test.ts
# → 1 pass, 0 fail

# Full suite — fail
bun test
# → 29 pass, 1 fail

# Pre-session baseline (e5d469d) full suite — same failure pattern
git checkout e5d469d && bun test  # → 29 pass, 1 fail
```

CI correctly excludes this package (`ci.yml` runs only `packages/kuralle-core` tests).

## Recommendation

- Run SIP integration tests with `--concurrency 1`, or
- Move the UDP test to a separate `*.integration.test.ts` file excluded from default `bun test`, or
- `/diagnose` port/global VOIP state under parallel execution.

Not fixed here — needs harness design choice.
