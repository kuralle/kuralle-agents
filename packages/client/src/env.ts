import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { config } from 'dotenv';

/**
 * Load environment variables for a CLI surface, from where the command was invoked.
 *
 * Bun already reads `<cwd>/.env` for anything it runs; Node does not. That difference meant the
 * same agent module worked through `kuralle` and failed through `kuralle-tui` with a message about
 * a missing API key rather than about the discrepancy.
 *
 * The CLI's previous loading was worse than absent: it resolved `.env` relative to the compiled
 * binary (`join(dist, '../../../.env')`), so it read the kuralle checkout's own file and ignored
 * the project the user was standing in. Installed from npm, those paths point inside node_modules.
 *
 * Precedence, highest first: a real environment variable, then `--env-file`, then `<cwd>/.env`.
 * dotenv never overwrites a value already in `process.env`, which is what keeps that order true.
 *
 * One divergence the two runtimes force, measured rather than assumed. Node 22 validates any
 * `--env-file` path it finds in argv even after the script name, and exits 9 with its own message
 * when the file is missing — before this function runs — though it does NOT apply the file from
 * that position. So on the Node CLI a valid path reaches us and works, while a typo'd path dies as
 * `node: <path>: not found` rather than with the error below. Bun passes the flag through
 * untouched, so the TUI gets this function's behaviour in both cases.
 */
export function loadEnvFile(explicitPath?: string): string | undefined {
  if (explicitPath) {
    const path = isAbsolute(explicitPath) ? explicitPath : resolve(process.cwd(), explicitPath);
    // An explicit flag that silently does nothing is worse than no flag.
    if (!existsSync(path)) throw new Error(`--env-file not found: ${path}`);
    config({ path });
    return path;
  }

  const cwdEnv = join(process.cwd(), '.env');
  if (!existsSync(cwdEnv)) return undefined;
  config({ path: cwdEnv });
  return cwdEnv;
}
