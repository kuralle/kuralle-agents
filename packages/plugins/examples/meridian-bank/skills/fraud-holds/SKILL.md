---
name: fraud-holds
description: When Meridian Bank holds an outbound transfer and what to tell the customer.
---

# Fraud holds (Meridian Bank)

**Skill teaches customer messaging; MCP tools execute or cancel transfers.** Holds are applied
by Meridian's fraud engine — this skill does not place or release holds.

## When a hold is placed

Meridian may hold an outbound transfer when:

- The destination payee was added within the last 24 hours.
- The amount exceeds USD 500 and the account has fewer than five prior outbound transfers.
- Velocity triggers: more than three transfers in one hour from the same account.

Held transfers appear as **pending** until review completes (typically within two business hours).

## What to tell the customer

Use plain language:

> "Meridian Bank has placed a brief security review on this transfer. Your funds are not
> debited until the review completes. You'll receive a notification when it clears or if we
> need more information."

Do **not** promise an exact release time unless the transfer id is already in pending status
(use MCP tools to inspect state when available).

## Cancelling a held transfer

If the customer declines to wait, use `cancel_transfer` with the pending transfer id. Only
**pending** transfers can be cancelled — completed transfers cannot be reversed through this
channel.
