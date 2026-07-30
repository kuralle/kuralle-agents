export interface CommerceEnv {
  CLOUDFLARE_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_GATEWAY_ID: string;
  OPENAI_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  DATABASE_URL?: string;
  SAMESAKE_API_KEY: string;
  PORULLE_URL: string;
  PORULLE_STOREFRONT_KEY: string;
  COMMERCE_IDENTITY_SECRET: string;
  STRIPE_PAYMENT_METHOD_TOKEN?: string;
  ENVIRONMENT?: string;
}

export function requireEnv(env: CommerceEnv): void {
  const required = [
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_GATEWAY_ID',
    'SAMESAKE_API_KEY',
    'PORULLE_URL',
    'PORULLE_STOREFRONT_KEY',
    'COMMERCE_IDENTITY_SECRET',
  ] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
}

export function databaseUrl(env: CommerceEnv & { HYPERDRIVE?: Hyperdrive }): string {
  const value = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL or HYPERDRIVE binding is required');
  return value;
}
