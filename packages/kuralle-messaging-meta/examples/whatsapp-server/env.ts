export const WHATSAPP_ENV_VARS = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_WABA_ID',
] as const;

export function getMissingWhatsAppEnv(): string[] {
  return WHATSAPP_ENV_VARS.filter((name) => !process.env[name]?.trim());
}

export function printSetupInstructions(missing: string[]): void {
  console.log(`
WhatsApp server example — missing required environment variables:

  ${missing.join('\n  ')}

Bring your own WhatsApp Cloud API number and token (no Embedded Signup):

  1. Create a Meta Developer app with WhatsApp Cloud API enabled
  2. Add a phone number and copy Phone Number ID + permanent access token
  3. Set a Verify Token (any secret string you choose)
  4. Copy App Secret from Meta app settings
  5. Copy WhatsApp Business Account ID (WABA ID)

Example:

  export WHATSAPP_ACCESS_TOKEN=...
  export WHATSAPP_APP_SECRET=...
  export WHATSAPP_PHONE_NUMBER_ID=...
  export WHATSAPP_VERIFY_TOKEN=...
  export WHATSAPP_WABA_ID=...

Model (one of):

  export OPENAI_API_KEY=...
  export GOOGLE_GENERATIVE_AI_API_KEY=...
  export XAI_API_KEY=...

Optional:

  export REDIS_URL=redis://127.0.0.1:6379
  export PORT=3333
  export KURALLE_EXAMPLE_PROVIDER=openai|google|xai

Run:

  bun run packages/kuralle-messaging-meta/examples/whatsapp-server/server.ts

Webhook URL (after deploy or ngrok):

  https://<host>/messaging/whatsapp/webhook
`);
}

export function printMissingModelInstructions(): void {
  console.log(`
WhatsApp server example — no live model API key found.

Set one of OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or XAI_API_KEY.
Optional: KURALLE_EXAMPLE_PROVIDER=openai|google|xai to force a provider.
`);
}
