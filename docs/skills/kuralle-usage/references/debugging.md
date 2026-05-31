# Debugging Guide

## Contents

- Triage leaks
- No context retrieved
- SOP ignored
- Session resets
- Tool failures

## Triage leaks

Symptom: user sees “handoff” language.

Fix:
- Set `triageMode: "structured"`
- Ensure triage agent never emits text

## No context retrieved

Fix:
- Verify `autoRetrieve` is configured
- Confirm tool name matches config
- Ensure retriever returns chunks

## SOP ignored

Fix:
- Put SOP in flow nodes, not prompts
- Keep prompts short

## Session resets

Fix:
- Reuse `sessionId` from runtime stream
- Use a session store for persistence

## Tool failures

Fix:
- Check tool.json schema
- Verify tool path in config
- Return structured output
