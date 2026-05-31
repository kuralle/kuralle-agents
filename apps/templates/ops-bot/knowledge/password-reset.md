# Self-service password reset (Okta)

Acme uses Okta for SSO. Employees can reset their own password in 4 steps.

## Self-service flow

1. Visit `acme.okta.example/reset`
2. Enter your work email; click **Send recovery link**
3. Click the link in your inbox (valid 15 minutes)
4. Set a new password (12+ characters, must include a digit + a symbol)

## When the recovery email never arrives

- Check spam/junk first
- Wait 5 minutes (sometimes delayed)
- If still missing: file a Linear ticket in the **IT** project, include
  your work email + the time you attempted the reset

## When the user is locked out (3+ failed attempts)

- Account auto-unlocks after 30 minutes
- Or: file a Linear ticket in the **IT** project asking for an immediate
  unlock. An IT on-call will action within 1 business hour.

## When the user has lost access to the recovery email

- This is the high-risk path — escalate. File a Linear ticket in the
  **IT** project tagged `security-review`, and IT will do a video
  identity-verification call before unlocking.

## What this bot WILL NOT do

- Reset passwords directly (Okta self-service is the only path)
- Bypass the 12-character requirement
- Skip the recovery email step
