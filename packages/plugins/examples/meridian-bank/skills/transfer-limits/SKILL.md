---
name: transfer-limits
description: Daily transfer caps and per-tier limits at Meridian Bank. Load before initiating any outbound transfer.
---

# Transfer limits (Meridian Bank)

**Skill teaches policy; MCP tools execute transfers.** This document states the limits a
customer-service agent must respect. It does not move money — call `transfer_funds` through
the Meridian MCP server after confirming the amount is within these bounds.

## Daily outbound cap

- **Standard checking and savings:** USD 2,500 per calendar day (UTC), all outbound
  transfers combined.
- **Premier tier** (not used in this demo): USD 10,000 per day.

Account `chk-001` (Avery Finch) is standard tier.

## Per-transfer ceiling

- Standard tier: no single transfer may exceed **USD 1,000**.
- Amounts above the per-transfer ceiling require a branch visit (out of scope for this agent).

## Procedure

1. Confirm the requested amount is ≤ USD 1,000 and ≤ remaining daily headroom.
2. Use MCP read tools (`get_balance`, `list_transactions`) to verify funds and recent activity.
3. Only then call `transfer_funds` with the approved amount.

If a customer asks to exceed a limit, explain the cap and do not attempt the transfer.
