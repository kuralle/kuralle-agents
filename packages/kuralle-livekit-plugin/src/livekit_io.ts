/**
 * Re-exports AudioInput, AudioOutput, and TextOutput from @livekit/agents.
 *
 * These abstract base classes are used internally by @livekit/agents but are
 * NOT included in its public package exports (they are exported from the
 * source file `voice/io.ts` but not re-exported from `voice/index.ts`).
 *
 * Strategy (hybrid, in priority order):
 *   1. Direct require of the compiled io module from known dist paths.
 *      If all three classes are found, use them. This is the most reliable
 *      approach because it loads the actual module LiveKit compiled.
 *   2. Prototype chain extraction for AudioOutput and TextOutput from
 *      exported subclasses (ParticipantAudioOutput, ParalellTextOutput).
 *      AudioInput has no exported subclass, so it can only come from (1).
 *
 * Types are extracted from AgentSession's public API using indexed access,
 * ensuring type identity with what AgentSession expects internally.
 *
 * Runtime assertions verify every extracted class has the expected prototype
 * shape. Breakage surfaces immediately at startup, not at first use.
 *
 * WARNING: This file reaches into @livekit/agents internals. Pin
 * @livekit/agents to a known-good version in production deployments.
 */
import { voice } from '@livekit/agents';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Type extraction from AgentSession's public property types
// ---------------------------------------------------------------------------

type _AudioInput = NonNullable<voice.AgentSession['input']['audio']>;
type _AudioOutput = NonNullable<voice.AgentSession['output']['audio']>;
type _TextOutput = NonNullable<voice.AgentSession['output']['transcription']>;

type AbstractConstructor<T> = abstract new (...args: unknown[]) => T;

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

function assertExtractedClass(
  name: string,
  value: unknown,
  heuristic: (proto: Record<string, unknown>) => boolean,
): asserts value is Function {
  if (typeof value !== 'function') {
    throw new Error(
      `@kuralle/livekit-plugin: Expected ${name} to be a constructor, got ${typeof value}. ` +
      'The installed @livekit/agents version may have restructured its internals. ' +
      'Pin @livekit/agents to a known-good version.',
    );
  }
  if (!heuristic(value.prototype)) {
    throw new Error(
      `@kuralle/livekit-plugin: Extracted ${name} does not match expected prototype shape. ` +
      'The installed @livekit/agents version may have changed the class hierarchy.',
    );
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Direct require of compiled io module
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);

let _agentsRoot: string;
try {
  _agentsRoot = dirname(_require.resolve('@livekit/agents/package.json'));
} catch {
  const agentsMain = _require.resolve('@livekit/agents');
  _agentsRoot = dirname(dirname(agentsMain));
}

const IO_PATHS = [
  'dist/voice/io.js',
  'dist/voice/io.cjs',
  'dist/cjs/voice/io.cjs',
  'dist/esm/voice/io.js',
];

type LiveKitIoModule = {
  AudioInput: AbstractConstructor<_AudioInput>;
  AudioOutput: AbstractConstructor<_AudioOutput>;
  TextOutput: AbstractConstructor<_TextOutput>;
};

let _ioModule: LiveKitIoModule | null = null;
for (const candidate of IO_PATHS) {
  try {
    const mod = _require(resolve(_agentsRoot, candidate));
    if (
      typeof mod.AudioInput === 'function' &&
      typeof mod.AudioOutput === 'function' &&
      typeof mod.TextOutput === 'function'
    ) {
      _ioModule = mod as LiveKitIoModule;
      break;
    }
  } catch {
    // Try next candidate
  }
}

// ---------------------------------------------------------------------------
// Resolve each class: prefer direct module, fall back to prototype extraction
// ---------------------------------------------------------------------------

// AudioOutput
const _ResolvedAudioOutput: Function = _ioModule?.AudioOutput
  ?? Object.getPrototypeOf(voice.ParticipantAudioOutput);

assertExtractedClass(
  'AudioOutput',
  _ResolvedAudioOutput,
  (proto) =>
    typeof (proto as { captureFrame?: unknown }).captureFrame === 'function' ||
    typeof (proto as { flush?: unknown }).flush === 'function',
);

export const AudioOutput = _ResolvedAudioOutput as AbstractConstructor<_AudioOutput> & {
  prototype: _AudioOutput;
};

// TextOutput
const _ResolvedTextOutput: Function = _ioModule?.TextOutput
  ?? Object.getPrototypeOf(voice.ParalellTextOutput);

assertExtractedClass(
  'TextOutput',
  _ResolvedTextOutput,
  (proto) =>
    typeof (proto as { onAttached?: unknown }).onAttached === 'function' ||
    typeof (proto as { onDetached?: unknown }).onDetached === 'function',
);

export const TextOutput = _ResolvedTextOutput as AbstractConstructor<_TextOutput> & {
  prototype: _TextOutput;
};

// AudioInput -- no exported subclass exists, so direct module is the only path.
// If the io module was not found, we have no fallback for AudioInput.
const _ResolvedAudioInput: Function | undefined = _ioModule?.AudioInput;

if (!_ResolvedAudioInput) {
  const tried = IO_PATHS.map((p) => resolve(_agentsRoot, p)).join(', ');
  throw new Error(
    '@kuralle-agents/livekit-plugin: Failed to load AudioInput from @livekit/agents. ' +
    `Tried paths: [${tried}]. ` +
    'The installed version of @livekit/agents may have restructured its internals. ' +
    'Pin @livekit/agents to a known-good version.',
  );
}

export const AudioInput = _ResolvedAudioInput as AbstractConstructor<_AudioInput> & {
  prototype: _AudioInput;
};

// ---------------------------------------------------------------------------
// Type re-exports
// ---------------------------------------------------------------------------

export type AudioInput = _AudioInput;
export type AudioOutput = _AudioOutput;
export type TextOutput = _TextOutput;

// Re-export utilities that ARE publicly exported from @livekit/agents
export { isTimedString, createTimedString } from '@livekit/agents';
export type { TimedString } from '@livekit/agents';
