---
"@kuralle-agents/core": minor
---

Fix three ways a streamed turn could fail the user without failing loudly.

**A failing turn no longer kills the process.** A `TurnHandle` is both a promise and an event source,
and a failing turn delivers its error down both. Consumers that only stream —
`toUIMessageStreamResponse()`, `toResponseStream()`, or iterating `handle.events` — never touch the
promise half, so that second delivery landed with no handler attached and took the whole process
down on `unhandledRejection`. One bad provider call killed a server for every other session on it.
The rejection is now marked handled at the source without being swallowed: `await runtime.run(...)`
still throws for anyone who awaits it.

**A turn that spends its whole step budget on tools still answers.** `maxSteps` defaults to 5, and an
agent that grounds itself, loads two skills, writes something and lints it exhausts that before it
ever summarises. The loop used to fall out with no further model call, so the turn ended with tool
results and no text at all — ten tool calls, a `finish`, and not one character for the user. Hitting
the ceiling now triggers one wrap-up call with no tools offered, because offering them would just
invite another call and reproduce the silence a step later. Typed extraction is unaffected; it is
deliberately mute and exits through its own stop condition.

**Proxies can no longer buffer a stream into a single frame.** `toUIMessageStreamResponse` sets
`Cache-Control: no-cache, no-transform`, `Content-Encoding: identity` and `X-Accel-Buffering: no`. A
Next.js rewrite in front of the server buffered the entire turn whenever compression was negotiated —
which a browser always does — so the UI showed a spinner for 37 seconds and then everything at once,
while a plain `curl` (which sends no `Accept-Encoding`) measured healthy the whole time.
Compressing an SSE stream buys nothing and costs the flush boundary.

`Limits` and `Guardrails` are now exported. `AgentConfig.limits` was public API whose type was
reachable from nowhere, so an app could set `maxSteps` but not name the type it was passing.
