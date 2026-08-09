import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '@kuralle-agents/plugins';
import { connectionFailureDiagnostic } from '../connect.js';

/**
 * Creates the plugin's data directory and proves the subprocess can write to it.
 *
 * §9.1 asks for three things: create it before launching, make it writable, and preserve
 * it across updates. The third is a property of *where* it lives — beside the plugin root
 * rather than inside it — so nothing here ever deletes it. §9.1 permits deletion only on
 * uninstall, which this codebase does not implement.
 *
 * `mkdir` succeeding does not prove writability: the directory can exist under a read-only
 * mount, or be owned by another user. A marker file is the only honest check, and it costs
 * one write per connection.
 */
export async function ensureWritableDataDirectory(
  serverName: string,
  dataRoot: string,
): Promise<Diagnostic | null> {
  const marker = join(dataRoot, '.kuralle-write-probe');
  try {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(marker, '');
    await rm(marker, { force: true });
    return null;
  } catch (error) {
    return connectionFailureDiagnostic(
      serverName,
      `PLUGIN_DATA directory "${dataRoot}" could not be created or written: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Agent Plugins §9.1 requires it to exist and be writable before the server starts.',
    );
  }
}
