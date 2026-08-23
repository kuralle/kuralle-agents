import {
  clearHostedConnection,
  connectionToTarget,
  createClient,
  readHostedConnection,
  saveHostedConnection,
  type Client,
  type HostedConnection,
  type Session,
  type Target,
} from '@kuralle-agents/client';
import { parseFlagArgs } from './parseFlagArgs.js';
import {
  parseAgentSlash,
  parseConnectSlash,
  resolveAgentTarget,
  resolveConnectTarget,
} from './resolveTarget.js';
import { rememberTarget, readRecentTargets } from './recentTargets.js';
import { CONNECT_HELP, formatConnectionInfo } from './ConnectScreen.js';

export interface SlashOutcome {
  handled: boolean;
  quit?: boolean;
  message?: string;
}

export interface SlashContext {
  client: Client | null;
  session: Session | null;
  target: Target | null;
  connection: HostedConnection | null;
  userId?: string;
  agentPath?: string;
  title: string;
  railTab?: 'memory' | 'trace';
  resetSession?: boolean;
}

export interface SlashHandlers {
  readHostedConnection: typeof readHostedConnection;
  saveHostedConnection: typeof saveHostedConnection;
  clearHostedConnection: typeof clearHostedConnection;
  readRecentTargets: typeof readRecentTargets;
  rememberTarget: typeof rememberTarget;
  resolveConnectTarget: typeof resolveConnectTarget;
  resolveAgentTarget: typeof resolveAgentTarget;
  createClient: typeof createClient;
}

export const defaultSlashHandlers: SlashHandlers = {
  readHostedConnection,
  saveHostedConnection,
  clearHostedConnection,
  readRecentTargets,
  rememberTarget,
  resolveConnectTarget,
  resolveAgentTarget,
  createClient,
};

function tokenFromEnv(): string | undefined {
  return process.env.KURALLE_TOKEN?.trim() || undefined;
}

export async function executeSlashCommand(
  raw: string,
  ctx: SlashContext,
  handlers: SlashHandlers = defaultSlashHandlers,
): Promise<{ outcome: SlashOutcome; next: Partial<SlashContext> }> {
  const line = raw.trim();
  if (!line.startsWith('/')) return { outcome: { handled: false }, next: {} };

  const [command, ...rest] = line.slice(1).split(/\s+/);
  const argsTail = rest.join(' ');

  switch (command) {
    case 'connect': {
      const resolved = await handlers.resolveConnectTarget(parseConnectSlash(argsTail));
      const client = handlers.createClient(resolved.target);
      const session = client.sessions.create();
      const url = parseFlagArgs(argsTail).positional[0];
      if (url) await handlers.rememberTarget(url);
      return {
        outcome: { handled: true },
        next: {
          client,
          session,
          target: resolved.target,
          connection: resolved.connection ?? null,
          title: resolved.label,
          agentPath: undefined,
          resetSession: true,
        },
      };
    }
    case 'agent': {
      const parsed = parseAgentSlash(argsTail);
      const resolved = await handlers.resolveAgentTarget(parsed);
      const client = handlers.createClient(resolved.target);
      const session = client.sessions.create();
      await handlers.rememberTarget(resolved.agentPath);
      return {
        outcome: { handled: true },
        next: {
          client,
          session,
          target: resolved.target,
          connection: null,
          title: resolved.label,
          agentPath: resolved.agentPath,
          resetSession: true,
        },
      };
    }
    case 'session': {
      const sessionId = argsTail.trim();
      if (!sessionId) {
        return { outcome: { handled: true, message: 'Usage: /session <id>' }, next: {} };
      }
      if (!ctx.client) {
        return { outcome: { handled: true, message: 'No active client — /connect first.' }, next: {} };
      }
      const session = ctx.client.sessions.attach(sessionId);
      return {
        outcome: { handled: true },
        next: { session, resetSession: true },
      };
    }
    case 'user': {
      const userId = argsTail.trim();
      if (!userId) {
        return { outcome: { handled: true, message: 'Usage: /user <id>' }, next: {} };
      }
      return { outcome: { handled: true, message: `Memory owner set to ${userId}` }, next: { userId } };
    }
    case 'disconnect': {
      if (ctx.session) await ctx.session.cancel('disconnect');
      return {
        outcome: { handled: true, message: 'Disconnected.' },
        next: {
          client: null,
          session: null,
          target: null,
          connection: null,
          title: 'Kuralle',
          agentPath: undefined,
        },
      };
    }
    case 'connection': {
      const saved = await handlers.readHostedConnection();
      const message = formatConnectionInfo(
        ctx.session ? { label: ctx.title, sessionId: ctx.session.id } : undefined,
        saved,
      );
      return { outcome: { handled: true, message }, next: {} };
    }
    case 'save': {
      if (!ctx.connection) {
        return { outcome: { handled: true, message: 'Nothing to save — connect to a hosted target first.' }, next: {} };
      }
      await handlers.saveHostedConnection(ctx.connection);
      return { outcome: { handled: true, message: 'Saved default connection.' }, next: {} };
    }
    case 'memory':
      return { outcome: { handled: true }, next: { railTab: 'memory' } };
    case 'trace':
      return { outcome: { handled: true }, next: { railTab: 'trace' } };
    case 'reset': {
      if (!ctx.client) {
        return { outcome: { handled: true, message: 'No active client.' }, next: {} };
      }
      if (ctx.session) await ctx.session.cancel('reset');
      const session = ctx.client.sessions.create();
      return {
        outcome: { handled: true, message: 'New session started.' },
        next: { session, resetSession: true },
      };
    }
    case 'help':
      return { outcome: { handled: true, message: CONNECT_HELP }, next: {} };
    case 'quit':
      return { outcome: { handled: true, quit: true }, next: {} };
    default:
      return { outcome: { handled: true, message: `Unknown command: /${command}` }, next: {} };
  }
}

export async function connectSavedConnection(
  handlers: SlashHandlers = defaultSlashHandlers,
): Promise<{
  target: Target;
  connection: HostedConnection;
  label: string;
  client: Client;
  session: Session;
} | undefined> {
  const connection = await handlers.readHostedConnection();
  if (!connection) return undefined;
  const token = tokenFromEnv();
  const target = connectionToTarget(connection, token ? { token } : undefined);
  const client = handlers.createClient(target);
  const session = client.sessions.create();
  const label = connection.agentName ? `${connection.server} · ${connection.agentName}` : connection.server;
  await handlers.rememberTarget(connection.server);
  return { target, connection, label, client, session };
}
