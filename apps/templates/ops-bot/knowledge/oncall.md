# On-call rotation

## Current rotation

Weekly. Handoff Mondays 09:00 in the rotation Linear ticket. The
outgoing on-call writes a one-paragraph handoff before they sign off.

## Pager triage

Routes by Linear ticket priority:

- **P1** → page (text + PagerDuty)
- **P2** → Slack DM to the on-call
- **P3** → ticket only (reviewed at standup)

## SLAs

- **P1** ack < 15 min
- **P2** ack < 1 hour
- **P3** ack < 4 business hours

## Bot's role

When a user describes an incident or "things are broken" or "the X
service is down":

1. **File** a Linear ticket in the INFRA project with priority calibrated
   to severity (P1 if anything is user-facing-down; P2 if degraded; P3 if
   minor)
2. **Tag** the current on-call (look them up via Okta `g_oncall` group)
3. **Reply** in Slack with the ticket link + the SLA expectation
4. **Stop** — don't try to triage the incident itself; the on-call is the
   human in the loop
