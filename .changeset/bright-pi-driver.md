---
"@kuralle-agents/core": minor
"@kuralle-agents/pi-driver": minor
"@kuralle-agents/cli": patch
---

Add a runtime-level channel-driver default and a stable inner model-loop SPI, then ship the Pi agent-core driver with durable Kuralle tools, streaming, control signals, bounded structured-decision retries, and Pi-native typed flows by default. Record client-observable TTFT on native and OTLP traces, surface it in the CLI, make flow-local executors survive source/dist module boundaries, and keep skill bodies behind `load_skill` instead of leaking filesystem paths into the model catalog.
