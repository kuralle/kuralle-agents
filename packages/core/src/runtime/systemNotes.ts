import type { RunState } from './durable/types.js';

const NOTES_KEY = '__systemNotes';

/**
 * A note the framework needs the model to see, that is not conversation.
 *
 * Five places used to express this by pushing `{ role: 'system' }` into the model message
 * list: the compaction summary, the flow context-reset summary, the escalation-resume
 * marker, the scheduled-wake note, and the recoverable-tool-error note. None of them are
 * turns anybody took — they are the runtime telling the model something about the run.
 *
 * Putting them in `messages` is wrong on two counts. The AI SDK warns that a system message
 * inside the message array is a prompt-injection surface, and AI SDK 7 rejects it outright.
 * More concretely: several of these notes carry text derived from user input — a compaction
 * summary is a summary *of what the user said*, and the tool-error note interpolates tool
 * output containing user-supplied ids. That is exactly the content that must not arrive
 * wearing an instruction's clothes.
 *
 * They belong in the system prompt, which every turn already composes separately.
 */
export type NoteLifetime =
  /** Consumed by the next turn that reads it, then gone. A wake note, a tool-error note. */
  | 'turn'
  /** Survives until something replaces it. A compaction summary stands in for real turns. */
  | 'run';

interface StoredNote {
  text: string;
  lifetime: NoteLifetime;
  /** Notes with the same tag replace each other — a second compaction supersedes the first. */
  tag?: string;
}

function read(state: Record<string, unknown>): StoredNote[] {
  const raw = state[NOTES_KEY];
  return Array.isArray(raw) ? (raw as StoredNote[]) : [];
}

/**
 * Add a note. A `tag` makes it idempotent: re-compacting replaces the previous summary
 * rather than stacking a second one, which is what made the old message-array approach
 * accumulate.
 */
export function addSystemNote(
  run: Pick<RunState, 'state'>,
  text: string,
  opts: { lifetime: NoteLifetime; tag?: string },
): void {
  if (!text.trim()) return;
  const existing = opts.tag ? read(run.state).filter((n) => n.tag !== opts.tag) : read(run.state);
  run.state[NOTES_KEY] = [...existing, { text, lifetime: opts.lifetime, tag: opts.tag }];
}

/** The blocks to fold into this turn's system prompt, oldest first. */
export function systemNoteBlocks(run: Pick<RunState, 'state'>): string[] {
  return read(run.state).map((n) => n.text);
}

/**
 * Drop the `turn`-lifetime notes. Call once after a turn has been composed, so a wake note
 * or a tool-error note informs exactly the turn it was raised for and does not leak into
 * every subsequent one — the failure mode that made the escalation-resume note reappear on
 * every turn after a resume.
 */
export function consumeTurnNotes(run: Pick<RunState, 'state'>): void {
  const kept = read(run.state).filter((n) => n.lifetime !== 'turn');
  if (kept.length === 0) delete run.state[NOTES_KEY];
  else run.state[NOTES_KEY] = kept;
}

/** Clear everything. Used when a fresh logical run should not inherit the previous one's notes. */
export function clearSystemNotes(run: Pick<RunState, 'state'>): void {
  delete run.state[NOTES_KEY];
}

/**
 * Drop the note carrying `tag`, if any. Used when the fact a note carries has been folded
 * into something more durable than the note itself — e.g. a skill-catalog delta note once
 * the roster it announced has been baked into a rebaselined `skillPrompt` at compaction —
 * so the note does not keep restating information the prompt now already contains.
 */
export function removeSystemNote(run: Pick<RunState, 'state'>, tag: string): void {
  const kept = read(run.state).filter((n) => n.tag !== tag);
  if (kept.length === 0) delete run.state[NOTES_KEY];
  else run.state[NOTES_KEY] = kept;
}
