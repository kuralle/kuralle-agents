/// <reference types="bun-types" />

/**
 * A real MCP server over stdio, run as a subprocess by `stdio-transport.test.ts`.
 *
 * It exists because the stdio path used to build its own result adapter, and the copy
 * dropped `isError` handling — a failed tool call came back as a successful value and was
 * journalled as a success. Only a genuine subprocess exercises that path end to end.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'stdio-fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Echo the message field',
    inputSchema: z.object({ message: z.string() }),
  },
  async (args) => ({ content: [{ type: 'text' as const, text: String(args.message ?? '') }] }),
);

server.registerTool(
  'book',
  {
    description: 'Book a flight, rejecting a date in the past',
    inputSchema: z.object({ date: z.string() }),
  },
  async () => {
    // The SDK marks a thrown handler as `isError` with the text in `content` — the exact
    // shape a client must surface rather than return.
    throw new Error('Invalid departure date: must be in the future.');
  },
);

await server.connect(new StdioServerTransport());
