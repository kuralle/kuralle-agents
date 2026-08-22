import { fingerprintToolCatalog } from '@kuralle-agents/core';
import { connectMcpServer } from '../../src/connect.js';
import type { McpConnectionStore, PersistedTool } from '../../src/types.js';

export async function listRemoteTools(config: {
  name: string;
  type: 'streamable-http';
  url: string;
}): Promise<PersistedTool[]> {
  const connected = await connectMcpServer(config, {
    timeoutMs: 5_000,
    allowedHosts: null,
    stdio: false,
    onDiagnostic: () => undefined,
  });
  if ('diagnostic' in connected) {
    throw new Error(connected.diagnostic.message);
  }
  try {
    return await connected.server.listTools();
  } finally {
    await connected.server.close();
  }
}

export async function seedTrustedListing(
  store: McpConnectionStore,
  config: { name: string; type: 'streamable-http'; url: string },
  listing: readonly PersistedTool[],
  trustedListing: readonly PersistedTool[],
) {
  const toolFingerprints = await fingerprintToolCatalog(trustedListing);
  await store.save({
    id: config.name,
    name: config.name,
    type: config.type,
    url: config.url,
    tools: [...listing],
    toolFingerprints,
  });
  return toolFingerprints;
}
