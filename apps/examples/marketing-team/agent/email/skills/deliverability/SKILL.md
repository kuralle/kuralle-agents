---
name: deliverability
description: Use when the question is whether email will reach the inbox, covering sending domain setup, authentication, list hygiene, complaint and bounce rates, or a drop in delivery.
allowed-tools: [lint_against_style]
---

# Deliverability

Deliverability advice is mostly unfalsifiable from where you sit. The `email_sends` record will tell you what this workspace knows about a send it made: the subject, the recipients, the status (`draft`, `queued`, `sent`, `failed`), and when it went out. It carries nothing about sending-domain setup, bounce or complaint counts, or inbox placement. Inbox placement, what any provider thinks of the domain today, and whether a filter is quietly junking the whole campaign are questions to raise rather than blanks to fill in.

That gap is the discipline in this skill. Report what you verified from the `email_sends` record, name what you could not check, and never let the first turn into the second. A domain with clean records is not evidence that mail is reaching inboxes, and saying it is does more damage than saying nothing.

The same rule applies to numbers. Every threshold here traces to a page listed in `references/checklist.md`, and the providers do not publish the same numbers, so quote a threshold with the provider attached and never quote one you cannot point at.

## Check first, in this order

1. Is the sending domain verified, and does the from address use it? This app has no domain-setup data to read, so that question goes straight to the user rather than being answered from a record. An unverified domain is the most common cause of mail that never leaves.
2. What happened to the last comparable send? Read its `email_sends` record: status, recipients, sent time. That is what this workspace can actually confirm; bounce and complaint counts are not tracked here, so say so rather than inferring them from status.
3. Is this a bulk sender situation? Close to 5,000 messages or more to personal Gmail accounts in 24 hours puts the domain permanently in Gmail's bulk sender category, and the requirements below become hard gates rather than good practice.
4. What changed? Deliverability problems are almost always a delta: new domain, new volume, a list imported from somewhere, a change in content or cadence. Ask what moved before theorizing.

## The requirements that are actually enforced

Google and Yahoo have enforced these since February 2024. Google ramped enforcement up again in November 2025, to include temporary and permanent rejections. Microsoft applies its own set to mail sent to Outlook.com and its other consumer domains from May 5, 2025. Mail that fails these gets rate-limited, junked, or rejected.

- SPF and DKIM both configured, and the From domain aligned with one of them. Authenticating without aligning is the trap: signing with a shared platform domain while sending from yours passes SPF and DKIM but fails DMARC. Google says alignment with both is likely to become a requirement, so treat one as the floor rather than the goal.
- DMARC published. Google and Yahoo both accept `p=none`, so the requirement is weaker than the advice: `quarantine` or `reject` is what protects the domain. Common guidance is to publish `p=none` first, confirm every sending source is passing, then move the policy up.
- One-click unsubscribe on marketing mail, meaning the `List-Unsubscribe` and `List-Unsubscribe-Post` headers together, plus a visible unsubscribe link in the body. A landing page with a login does not satisfy it. Google and Yahoo both began enforcing it in June 2024. Then honor the request quickly: Yahoo requires two days, Google recommends 48 hours.
- Spam complaint rate below 0.30% at both Google and Yahoo, which is where enforcement starts rather than a safe place to sit. Google's own recommendation is to stay below 0.10%.

These pages get revised, and the dates above were checked in July 2026. When the answer turns on a specific threshold, fetch the source from the list in `references/checklist.md` instead of quoting from memory.

## What the law requires, which is a separate question

Everything above is what mailbox providers enforce. Marketing mail also has to satisfy the law where the recipients are, and those rules do not care about your complaint rate. A send can be perfectly deliverable and still unlawful.

Two of these are checkable by reading the copy, so check them every time:

- A valid physical postal address of the sender, in the message. US law requires it in every commercial message, and it is the single most commonly missing element.
- Identification that the message is an advertisement, clear and conspicuous, unless the recipient gave prior affirmative consent. Plus clear notice of how to decline further mail.

Two more are about the mechanism rather than the copy. The opt-out has to stay capable of receiving requests for at least 30 days after the send, and a request has to be honored within 10 business days. Both are process questions for whoever runs the list.

Consent is the part you cannot inspect, and it is the part that differs most by jurisdiction. In the UK and the EU, marketing email to individuals needs prior consent, with a narrow exception for people whose details you collected while selling them something, where you market only similar products and you offered a free and simple way to refuse both at collection and in every message since. A February 2026 amendment extended a version of that exception to charities. Under the GDPR, direct marketing can rest on legitimate interests, but a person's objection to direct marketing ends the matter, with no balancing against your interest in sending.

So ask rather than assume. Where the list came from, whether consent was recorded, and which countries the recipients are in are all questions for the user, and the answer changes what is allowed. Say plainly that you are naming requirements rather than giving legal advice, and that US, UK, and EU rules are not the whole world: a list spanning other markets needs someone to confirm what applies.

## What follows from the complaint rate

Almost every list decision comes back to that number, and it is small enough to be worth making concrete: at 10,000 delivered, 30 complaints is the ceiling.

- Yahoo computes its rate over mail delivered to the inbox rather than over everything it accepted, so a rate worked out from a send's own totals reads lower than the one Yahoo acts on. That is a reason to leave room under 0.30% rather than to sit on it.
- A hidden or awkward unsubscribe does not keep subscribers. It converts people who would have left quietly into complaints, which is the expensive outcome.
- Mailing people who never engage is not free. It suppresses reach for the people who do want the mail.
- A list you did not build is the fastest way to the ceiling. Purchased or scraped addresses, and old lists imported from a previous tool, arrive with no consent record and often with spam traps in them.
- Sudden volume increases read as a change in behavior. Ramp new sending volume instead of jumping straight to full send size, keep complaint and bounce rates well under the enforcement floor while ramping, and slow down if either climbs.

## Say what you cannot see

State these as open questions rather than findings, every time:

- Whether mail landed in the inbox or the spam folder. `email_sends.status = 'sent'` means the send was attempted, nothing more.
- The domain's current reputation with any provider. That lives in Google Postmaster Tools, Microsoft SNDS, and Yahoo's Complaint Feedback Loop.
- Whether the DMARC record is published, and at what policy, unless the user tells you or shows you.
- Bounce counts, complaint counts, and blocklist status. Nothing in this workspace tracks them.
- Whether there is a lawful basis for mailing this list, and which jurisdictions it spans.
- How the email renders across clients.
- Open rates as a measure of anything on Apple clients, since Mail Privacy Protection inflates them.

When one of these is the actual question, say what would answer it and who can check. Pointing the user at Postmaster Tools is a better answer than a confident guess.

## References

- `references/checklist.md`: the checks in priority order, each marked with what verifies it in this workspace or `none` when nothing available here can, plus the concrete thresholds, each attributed to the page it came from. Its last section covers the legal requirements, which sit outside that priority order because a send that fails them should not go out at all.

## Layers on top of

`email-style` covers the content side of the same problem: the copy patterns that get mail reported, and the unsubscribe and sender-identity conventions that keep complaints low.
