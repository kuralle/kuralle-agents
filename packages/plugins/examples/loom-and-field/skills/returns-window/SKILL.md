---
name: returns-window
description: Loom & Field return period, exceptions, and customer messaging. Load before opening or explaining a return.
---

# Returns window (Loom & Field)

**Skill teaches return policy; MCP tools execute return requests.** This document states the
return window and its exceptions. It does not submit returns — call `start_return` through the
Loom MCP server after confirming eligibility.

## Standard return period

- **30 calendar days** from delivery confirmation for unworn items with tags attached.
- Refunds post to the original payment method within 5–7 business days after the warehouse
  receives the parcel.

## Exceptions (no return)

- **Final-sale** items marked at checkout — these are non-refundable.
- **Monogrammed or altered** garments once personalization is applied.
- **Intimate apparel** and swimwear once the hygiene seal is broken.

## Procedure

1. Confirm the order id and sku with MCP `get_order_status`.
2. Verify the item is not in the exceptions list above.
3. Only then call `start_return` with the order id, sku, and reason.

If a customer is outside the 30-day window, explain the policy politely and do not call
`start_return`.
