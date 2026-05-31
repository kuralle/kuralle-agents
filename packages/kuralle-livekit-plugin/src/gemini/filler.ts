export interface ParsedFillerResponse {
  transcript: string;
  filler: string;
  parsedAsJson: boolean;
}

export interface BuildFillerInstructionOptions {
  baseInstruction?: string;
  fillerPrompt?: string;
  fillerMinTranscriptLength: number;
}

export const DEFAULT_FILLER_PROMPT = [
  'You are a speech transcription service for a voice assistant.',
  'Return STRICT JSON only in this schema:',
  '{"transcript":"<exact user speech>","filler":"<short natural acknowledgement>"}',
  'Rules for filler:',
  '- Keep it to one short sentence.',
  '- Do not invent facts or outcomes.',
  '- Use empty string for very short replies (yes/no/okay).',
  '- Keep tone conversational and neutral.',
].join('\n');

export function buildFillerInstruction(opts: BuildFillerInstructionOptions): string {
  const prefix = opts.baseInstruction?.trim();
  const prompt = (opts.fillerPrompt?.trim() || DEFAULT_FILLER_PROMPT).trim();

  return [
    prefix,
    prompt,
    `Emit empty filler when transcript length is below ${opts.fillerMinTranscriptLength} characters.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function parseFillerResponse(raw: string): ParsedFillerResponse {
  const text = raw.trim();
  if (!text) {
    return { transcript: '', filler: '', parsedAsJson: false };
  }

  try {
    const parsed = JSON.parse(text) as { transcript?: unknown; filler?: unknown };
    const transcript = typeof parsed.transcript === 'string' ? parsed.transcript.trim() : '';
    const filler = typeof parsed.filler === 'string' ? parsed.filler.trim() : '';

    if (!transcript) {
      return { transcript: text, filler: '', parsedAsJson: false };
    }

    return {
      transcript,
      filler,
      parsedAsJson: true,
    };
  } catch {
    return {
      transcript: text,
      filler: '',
      parsedAsJson: false,
    };
  }
}
