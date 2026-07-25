---
"@kuralle-agents/core": patch
---

Fix concurrent `ctx.tool` calls so each new durable effect receives a unique journal ordinal and can be used directly inside `Promise.all`; document the supported action-node pattern and improve log-conflict guidance.
