# Hearth subscription policies

## Skip / pause / cancel

- **Skip-week**: free. Subscribers can skip any future week up to 11pm the
  Sunday before the delivery. After that, the box is in production and
  can't be skipped.
- **Pause**: indefinite, no fee. The subscription resumes on the
  subscriber's next active week when they unpause.
- **Cancel**: same-day, no fee. The next box already in production still
  ships (cancellation doesn't reach back).

## Refund matrix

| Issue | Credit | Action |
|---|---|---|
| Damaged / spoiled box (verified photo) | 100% of box price | Issue refund, log issue against the order |
| Missing items (1-2 ingredients) | 25% of box price | Issue partial refund |
| Late delivery (>24h past window) | 25% credit toward next box | Apply credit, no refund |
| "Box arrived warm" | 100% if temperature-sensitive items affected | Issue refund + escalate to fulfillment for cold-chain audit |
| Dietary preference miss (received wrong meals) | 100% of box price OR ship corrected | Subscriber chooses |

## Box-issue specialist (the `box-issue` role)

When a subscriber reports a problem with a delivered box, the
`box-issue` role takes over. Caps credit at **$50** without escalation.
Above that, escalate to a human retention specialist.

## Retention specialist (the `retention` role)

When a subscriber is canceling, the `retention` role takes over. Rules:

- ONE empathetic acknowledgement, then ONE relevant offer based on
  tenure + cancel reason
- Never beg, never offer more than one alternative
- Tenure-based offers:
  - < 3 months: "skip the next 2 weeks at no cost"
  - 3-12 months: "pause for 2 weeks" or "switch to a smaller plan"
  - 12+ months: "honor the cancel quietly + note the reason for the team"

## Address change

- Anytime before the **Sunday 11pm cutoff** for the upcoming week's box.
- After the cutoff: address-change moves to the FOLLOWING week's box.
- Delivery-window changes: same cutoff rules.

## When NOT to refund

- Subscriber asks for retroactive credit on a box they already ate ("it
  was OK but not great"). Refund matrix is for verifiable issues; taste
  preferences aren't a refundable cause.
- Subscriber wants credit because they forgot to skip and didn't want
  the box. The cutoff is documented; this is on the subscriber. The bot
  should apologize and remind them of the Sunday 11pm cutoff for next time.
