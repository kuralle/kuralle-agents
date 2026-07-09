import type { ModelMessage } from 'ai';
import type {
  InputProcessor,
  OutputProcessor,
  ProcessorContext,
  InputProcessorResult,
  OutputProcessorResult,
} from '../types/index.js';

export type InputProcessorOutcome =
  | { blocked: false; input: string; result?: InputProcessorResult }
  | { blocked: true; input: string; processorId: string; reason: string; message: string; result?: InputProcessorResult };

export type OutputProcessorOutcome =
  | { blocked: false; text: string; result?: OutputProcessorResult }
  | { blocked: true; text: string; processorId: string; reason: string; message: string; result?: OutputProcessorResult };

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'Operation cancelled');
}

export async function runInputProcessors(args: {
  processors: InputProcessor[];
  input: string;
  messages: ModelMessage[];
  context: ProcessorContext;
}): Promise<InputProcessorOutcome> {
  let cur = args.input;
  throwIfAborted(args.context.abortSignal);
  for (const p of args.processors) {
    throwIfAborted(args.context.abortSignal);
    const res = await p.process({ input: cur, messages: args.messages, context: args.context });
    throwIfAborted(args.context.abortSignal);
    if (!res || res.action === 'allow') continue;
    if (res.action === 'modify' && typeof res.input === 'string') {
      cur = res.input;
      continue;
    }
    if (res.action === 'block') {
      return {
        blocked: true,
        input: cur,
        processorId: p.id,
        reason: res.reason ?? 'Blocked by input processor',
        message: res.message ?? 'Sorry, I cannot help with that request.',
        result: res,
      };
    }
  }
  return { blocked: false, input: cur };
}

export async function runOutputProcessors(args: {
  processors: OutputProcessor[];
  text: string;
  messages: ModelMessage[];
  context: ProcessorContext;
}): Promise<OutputProcessorOutcome> {
  let cur = args.text;
  throwIfAborted(args.context.abortSignal);
  for (const p of args.processors) {
    throwIfAborted(args.context.abortSignal);
    const res = await p.process({ text: cur, messages: args.messages, context: args.context });
    throwIfAborted(args.context.abortSignal);
    if (!res || res.action === 'allow') continue;
    if (res.action === 'modify' && typeof res.text === 'string') {
      cur = res.text;
      continue;
    }
    if (res.action === 'block') {
      return {
        blocked: true,
        text: cur,
        processorId: p.id,
        reason: res.reason ?? 'Blocked by output processor',
        message: res.message ?? 'Sorry, I cannot provide that response.',
        result: res,
      };
    }
  }
  return { blocked: false, text: cur };
}
