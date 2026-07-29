import { config as loadDotEnv } from 'dotenv';
import { resolve } from 'node:path';

const workingDirectory = process.cwd();
loadDotEnv({ path: resolve(workingDirectory, '.env'), quiet: true });
loadDotEnv({ path: resolve(workingDirectory, '../../..', '.env'), quiet: true });
loadDotEnv({ path: resolve(workingDirectory, 'apps/examples/postgres-hacker-starter/.env.local'), override: true, quiet: true });
loadDotEnv({ path: resolve(workingDirectory, '.env.local'), override: true, quiet: true });

export function requireServerEnv(name: 'DATABASE_URL' | 'OPENAI_API_KEY' | 'KURALLE_COOKIE_SECRET'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  if (name === 'KURALLE_COOKIE_SECRET' && value.length < 32) {
    throw new Error('KURALLE_COOKIE_SECRET must contain at least 32 characters.');
  }
  return value;
}
