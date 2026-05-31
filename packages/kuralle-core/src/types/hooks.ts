import type { ConversationOutcomeRecord } from '../outcomes/types.js';
import type { HarnessStreamPart } from './stream.js';
import type { RunContext } from './run-context.js';
import type { Session } from './session.js';
import type { TurnUsage } from './telemetry.js';

export interface Hooks {
  onStart?: (ctx: RunContext) => void | Promise<void>;
  onStreamPart?: (ctx: RunContext, part: HarnessStreamPart) => void | Promise<void>;
  onEnd?: (ctx: RunContext) => void | Promise<void>;
  onConversationEnd?: (args: {
    session: Session;
    outcome?: ConversationOutcomeRecord;
    usage?: TurnUsage;
  }) => void | Promise<void>;
  onError?: (ctx: RunContext, error: Error) => void | Promise<void>;
}
