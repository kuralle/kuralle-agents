import type { FileSystem } from '@kuralle-agents/core';
import { fsSkillStore, type SkillStoreLike } from '@kuralle-agents/core';
import { containsResolvedPath, normalizePath, resolvePath } from '@kuralle-agents/fs';
import { emptySkillStore } from './empty-skill-store.js';
import { validateManifestJson } from './manifest.js';
import {
  defaultPluginDataRoot,
  loadMcpConfig,
  MCP_CONFIG_FILE,
} from './mcp.js';
import { rejection } from './diagnostics.js';
import type { Diagnostic, LoadPluginResult, McpServerConfig } from './types.js';

const MANIFEST_FILE = 'plugin.json';
const SKILLS_DIR = 'skills';

function toPluginRelative(pluginRoot: string, absolutePath: string): string {
  const normalizedRoot = normalizePath(pluginRoot);
  const normalizedPath = normalizePath(absolutePath);
  if (normalizedPath === normalizedRoot) {
    return '.';
  }
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath;
}

async function loadSkillsComponent(
  fs: FileSystem,
  pluginRoot: string,
  diagnostics: Diagnostic[],
): Promise<SkillStoreLike> {
  const skillsPath = resolvePath(pluginRoot, SKILLS_DIR);

  if (!(await fs.exists(skillsPath))) {
    return emptySkillStore();
  }

  let stat;
  try {
    stat = await fs.stat(skillsPath);
  } catch {
    diagnostics.push({
      section: '6.2',
      rule: 'component-location-wrong-kind',
      origin: SKILLS_DIR,
      message: `${SKILLS_DIR} could not be read.`,
    });
    return emptySkillStore();
  }

  if (stat.type !== 'directory') {
    diagnostics.push({
      section: '6.2',
      rule: 'component-location-wrong-kind',
      origin: SKILLS_DIR,
      message: `${SKILLS_DIR} is not a directory.`,
    });
    return emptySkillStore();
  }

  return fsSkillStore(fs, [skillsPath], {
    onDiagnostic: (d) => {
      diagnostics.push({
        section: '7.1',
        rule: 'skill-invalid',
        origin: toPluginRelative(pluginRoot, d.skillPath),
        message: d.message,
      });
    },
  });
}

export async function loadAgentPlugin(
  fs: FileSystem,
  root: string,
): Promise<LoadPluginResult> {
  const normalizedRoot = normalizePath(root);
  const manifestPath = resolvePath(normalizedRoot, MANIFEST_FILE);

  let manifestText: string;
  try {
    if (!(await fs.exists(manifestPath))) {
      return {
        ok: false,
        ...rejection(
          '5.1',
          'manifest-missing',
          MANIFEST_FILE,
          `${MANIFEST_FILE} is not present in the plugin root.`,
        ),
      };
    }
    // Containment is checked here rather than before the existence check: a resolved
    // check cannot distinguish "absent" from "escaping", and §5.1's manifest-missing
    // rejection must survive. Once the file exists, an escaping symlink is the only way
    // this fails — which is exactly §4.1 rule 1.
    if (!(await containsResolvedPath(fs, normalizedRoot, manifestPath))) {
      return {
        ok: false,
        ...rejection(
          '4.1',
          'path-escapes-plugin-root',
          MANIFEST_FILE,
          `${MANIFEST_FILE} resolves outside the plugin root.`,
        ),
      };
    }

    manifestText = await fs.readFile(manifestPath);
  } catch {
    return {
      ok: false,
      ...rejection(
        '5.1',
        'manifest-unreadable',
        MANIFEST_FILE,
        `${MANIFEST_FILE} could not be read.`,
      ),
    };
  }

  const validation = validateManifestJson(manifestText);
  if (!validation.ok) {
    return validation;
  }

  const skillDiagnostics: Diagnostic[] = [];
  const skills = await loadSkillsComponent(fs, normalizedRoot, skillDiagnostics);
  await skills.list();

  const componentDiagnostics: Diagnostic[] = [...skillDiagnostics];
  let mcpServers: McpServerConfig[] = [];

  const mcpPath = resolvePath(normalizedRoot, MCP_CONFIG_FILE);
  if (await fs.exists(mcpPath)) {
    try {
      const mcpText = await fs.readFile(mcpPath);
      const pluginDataRoot = defaultPluginDataRoot(
        normalizedRoot,
        validation.manifest.name,
      );
      const mcpResult = loadMcpConfig(
        mcpText,
        validation.manifest.$schema,
        normalizedRoot,
        pluginDataRoot,
      );
      mcpServers = [...mcpResult.mcpServers];
      componentDiagnostics.push(...mcpResult.diagnostics);
    } catch {
      componentDiagnostics.push({
        section: '7.2.2',
        rule: 'mcp-config-invalid',
        origin: MCP_CONFIG_FILE,
        message: 'mcp.json could not be read.',
      });
    }
  }

  return {
    ok: true,
    plugin: {
      manifest: validation.manifest,
      skills,
      mcpServers,
      diagnostics: [...validation.diagnostics, ...componentDiagnostics],
    },
  };
}
