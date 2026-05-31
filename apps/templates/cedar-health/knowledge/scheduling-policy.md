# Scheduling policy

## Appointment types

| Type | Duration | Booking rules |
|---|---|---|
| Annual physical | 60 min | Once per 12 months; can book up to 6 months out |
| Follow-up | 30 min | After a recent visit; with the same provider |
| New-patient intake | 90 min | First visit only; routes to a PCP |
| Specialist consult | 45 min | Requires referral from PCP |

## Identity-verification gate

The bot must call `verify_identity` BEFORE listing or modifying any
appointment. The verification check needs MRN + date of birth as a soft
challenge. (Production deployments add a phone-OTP step on top — that's
out of scope for this template.)

If verification fails:
- Stop tool use immediately
- Apologize, ask the patient to try again
- Two failed attempts → escalate to a human scheduler

## Rescheduling rules

- The bot can reschedule to ANY open slot with the same provider
- For provider changes (e.g., the original doctor is on leave),
  escalate to a human scheduler — the bot doesn't auto-rebook to a
  different provider
- 24h cancellation policy: same-day cancels are allowed but logged;
  the patient is told the policy

## What the bot won't book

- New specialist consults without a documented PCP referral (escalate)
- Procedures (any tool that isn't a routine office visit — escalate)
- Anything for a different patient (verification only covers the
  calling patient)
