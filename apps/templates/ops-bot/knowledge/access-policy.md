# Staging database access policy

**Who approves:** the requester's manager + a data-platform on-call.

## Process

1. File a Linear ticket in the SECURITY project with the migration scope,
   expected duration, and a one-line justification.
2. Tag the data-platform on-call (resolve from the `g_oncall` Okta group).
3. Access expires automatically after **7 days** unless explicitly extended.

## What counts as "migration scope"

- Tables you'll read or write
- Expected row volumes
- Whether you'll be running DDL (CREATE TABLE / ALTER, etc)
- Whether you'll be running long-lived transactions

## Rejection criteria

- **PII tables** (require legal sign-off — escalate, do not auto-approve)
- **Payments tables** (require finance sign-off — escalate)
- **More than 7 days** of access without a documented justification

## Default approval template

When all criteria pass:
- Ticket priority: P2
- Assigned to: requester's manager (resolved via Okta)
- Auto-comment with the policy link + the 7-day expiry reminder

## When in doubt

Escalate. The data-platform on-call is the human in the loop; the bot's
job is to gather the right context and file a clean ticket — not to make
the access decision.
