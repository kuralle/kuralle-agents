# Rx refills policy

## What the bot CAN refill

- Routine maintenance medications with refills remaining
- The patient's own prescriptions (verified via patient identity)
- Calling out which pharmacy will receive the refill

## What the bot CANNOT do

- Refill controlled substances of any schedule (route to provider)
- Refill prescriptions with `status: needs_renewal` — the prescriber
  has to approve a renewal. The bot CAN file a renewal request via
  `request_renewal`; that routes to the prescriber's inbox.
- Change dosage or quantity (out of scope; provider decision)
- Switch generic to brand (or vice versa) without provider sign-off

## When refills are out

When a refill request returns `error: 'no_refills_remaining'` and
`nextStep: 'request_renewal'`:

1. Tell the patient the prescription needs renewal and which prescriber
   it's going to
2. File the renewal request via `request_renewal` with a one-line
   note from the patient if they have one
3. Set the expectation: prescriber typically responds within 1-2
   business days
4. Tell the patient they can call the office if they need it sooner

## Pharmacy selection

The default pharmacy in the prescription record is used unless the
patient asks to switch. Pharmacy switching for an in-flight refill
needs to be a brand-new refill request at the new pharmacy — the
mock service doesn't model the cross-pharmacy transfer.
