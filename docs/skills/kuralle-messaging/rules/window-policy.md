# Messaging Window Policy

## Never silently send template messages

The 24-hour window exists to prevent spam. Template messages require Meta review and are billed per conversation (varies by country and category). Silently falling back to templates can generate unexpected charges.

The SDK throws `WindowClosedError` on `sendText()` outside the window. Catch it and decide explicitly:
- Send a template if one is appropriate and approved
- Queue the message for when the window reopens
- Drop it if the conversation is stale

`sendTextOrTemplate()` is provided for cases where you're certain the fallback template is appropriate. Don't use it as a default to suppress the error.

## Always verify webhook signatures

All Meta webhook deliveries are signed with HMAC-SHA256 using your app secret. `createMessagingRouter()` verifies automatically. If you build a custom handler, always call `verifySignature()` before processing any payload.

Skipping verification allows any actor to inject arbitrary messages into your agent.

## MessageDeduplicator is always required

Meta retries deliveries when your server responds slowly. Without deduplication, a slow agent response (e.g., 15s LLM call) causes the same message to be processed 2-3 times and the user gets duplicate replies.

`createMessagingRouter()` handles this automatically. Custom handlers must implement deduplication manually.

## Instagram text limit

Instagram DMs have a 1000-byte UTF-8 limit, not 1000 characters. Emoji and non-ASCII characters count as multiple bytes. Keep responses concise or split across multiple messages for international content.
