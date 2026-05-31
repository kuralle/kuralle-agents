/**
 * Wire-protocol helpers for the Node OpenAI Realtime client.
 *
 * Sibling of `cloudflare/openai-family/protocol.ts`. Both speak the same
 * `session.update` schema; this file is split out from
 * `OpenAIRealtimeClient.ts` so the Node client stays focused on the
 * `ws`-package lifecycle while the schema definitions live in one
 * inspectable place.
 */

import type {
  RealtimeCapabilities,
  RealtimeSessionConfig,
} from '@kuralle-agents/core/realtime';
import type { GeminiFunctionDeclaration } from '@kuralle-agents/core/capabilities';

export const OPENAI_REALTIME_CAPABILITIES: RealtimeCapabilities = {
  turnDetection: true,
  userTranscription: true,
  messageTruncation: true,
  autoToolReplyGeneration: false,
  audioOutput: true,
  manualFunctionCalls: true,
  midSessionChatCtxUpdate: true,
  midSessionInstructionsUpdate: true,
  midSessionToolsUpdate: true,
  perResponseToolChoice: true,
};

export interface OpenAIFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type OpenAIAudioFormat = 'pcm16' | 'pcmu' | 'pcma';

/**
 * Map an Kuralle audio-format identifier to the MIME string the OpenAI
 * Realtime `session.update` schema expects.
 */
export function formatToMime(format: OpenAIAudioFormat): string {
  switch (format) {
    case 'pcmu':
      return 'audio/pcmu';
    case 'pcma':
      return 'audio/pcma';
    case 'pcm16':
    default:
      return 'audio/pcm16';
  }
}

/**
 * Convert an authority-emitted JSON-Schema function declaration into the
 * OpenAI Realtime tool envelope.
 */
export function geminiDeclToOpenAITool(decl: GeminiFunctionDeclaration): OpenAIFunctionTool {
  return {
    type: 'function',
    name: decl.name,
    description: decl.description,
    parameters: decl.parameters,
  };
}

export interface BuildSessionUpdateOpts {
  defaultModel: string;
}

/**
 * Build a `session.update` payload from a `RealtimeSessionConfig`. Uses the
 * GA OpenAI Realtime API schema (no OpenAI-Beta header). The semantic VAD
 * defaults match the `@livekit/agents-plugin-openai` defaults so behavior is
 * consistent across cascaded vs realtime paths.
 */
export function buildSessionUpdate(
  config: RealtimeSessionConfig,
  opts: BuildSessionUpdateOpts,
): Record<string, unknown> {
  const inputFormat = (config.audio?.inputFormat ?? 'pcm16') as OpenAIAudioFormat;
  const outputFormat = (config.audio?.outputFormat ?? 'pcm16') as OpenAIAudioFormat;

  const audioInputMime = formatToMime(inputFormat);
  const audioOutputMime = formatToMime(outputFormat);

  const tools: OpenAIFunctionTool[] = (config.tools ?? []).map(geminiDeclToOpenAITool);

  const session: Record<string, unknown> = {
    type: 'realtime',
    model: config.model ?? opts.defaultModel,
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: audioInputMime },
        transcription: { model: 'whisper-1' },
        noise_reduction: { type: 'near_field' },
        turn_detection: {
          type: 'semantic_vad',
          create_response: true,
          eagerness: 'medium',
        },
      },
      output: {
        format: { type: audioOutputMime },
        ...(config.voice ? { voice: config.voice } : {}),
      },
    },
    instructions: config.systemInstruction,
  };

  if (tools.length > 0) {
    session.tools = tools;
    session.tool_choice = 'auto';
  }

  return { type: 'session.update', session };
}
