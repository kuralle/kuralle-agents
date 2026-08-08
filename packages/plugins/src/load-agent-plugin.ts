import type { FileSystem } from '@kuralle-agents/core';
import { normalizePath, resolvePath } from '@kuralle-agents/fs';
import { emptySkillStore } from './empty-skill-store.js';
import { validateManifestJson } from './manifest.js';
import type { LoadPluginResult } from './types.js';

const MANIFEST_FILE = 'plugin.json';

function isContained(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}/`)
  );
}

export async function loadAgentPlugin(
  fs: FileSystem,
  root: string,
): Promise<LoadPluginResult> {
  const normalizedRoot = normalizePath(root);
  const manifestPath = resolvePath(normalizedRoot, MANIFEST_FILE);

  if (!isContained(normalizedRoot, manifestPath)) {
    return {
      ok: false,
      rejection: {
        section: '4.1',
        rule: 'path-escapes-plugin-root',
        message: `${MANIFEST_FILE} resolves outside the plugin root.`,
      },
      diagnostics: [
        {
          section: '4.1',
          rule: 'path-escapes-plugin-root',
          origin: MANIFEST_FILE,
          message: `${MANIFEST_FILE} resolves outside the plugin root.`,
        },
      ],
    };
  }

  let manifestText: string;
  try {
    if (!(await fs.exists(manifestPath))) {
      return {
        ok: false,
        rejection: {
          section: '5.1',
          rule: 'manifest-missing',
          message: `${MANIFEST_FILE} is not present in the plugin root.`,
        },
        diagnostics: [
          {
            section: '5.1',
            rule: 'manifest-missing',
            origin: MANIFEST_FILE,
            message: `${MANIFEST_FILE} is not present in the plugin root.`,
          },
        ],
      };
    }
    manifestText = await fs.readFile(manifestPath);
  } catch {
    return {
      ok: false,
      rejection: {
        section: '5.1',
        rule: 'manifest-unreadable',
        message: `${MANIFEST_FILE} could not be read.`,
      },
      diagnostics: [
        {
          section: '5.1',
          rule: 'manifest-unreadable',
          origin: MANIFEST_FILE,
          message: `${MANIFEST_FILE} could not be read.`,
        },
      ],
    };
  }

  const validation = validateManifestJson(manifestText);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    plugin: {
      manifest: validation.manifest,
      skills: emptySkillStore(),
      mcpServers: [],
      diagnostics: validation.diagnostics,
    },
  };
}
