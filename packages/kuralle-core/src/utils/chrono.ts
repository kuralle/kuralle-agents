import * as chrono from 'chrono-node';
import { createTool } from '../tools/Tool.js';
import { z } from 'zod';
import type { Tool } from '../tools/Tool.js';

export interface DateParserOptions {
  referenceDate?: Date;
  forwardDate?: boolean;
  timezones?: Record<string, number>;
}

export interface ParsedDateResult {
  date?: Date;
  text: string;
  confidence: number;
  start: number;
  end: number;
}

const dateParserInputSchema = z.object({
  text: z.string().describe('Natural language date (e.g., "tomorrow at 3pm", "next Friday")'),
  referenceDate: z.string().optional().describe('Reference date in ISO format'),
  timezone: z.string().optional().describe('Timezone (e.g., "America/New_York")'),
});

type DateParserInput = z.infer<typeof dateParserInputSchema>;

type DateParserOutput =
  | {
      success: true;
      input: string;
      parsed: {
        date: string;
        text: string;
        confidence: number;
        start: number;
        end: number;
      };
      startDate: string | undefined;
      endDate: string | undefined;
    }
  | { success: false; error: string; text: string };

export function createDateParser(options: DateParserOptions = {}): Tool<DateParserInput, DateParserOutput> {
  return createTool<typeof dateParserInputSchema, DateParserOutput>({
    description: 'Parse natural language dates into structured Date objects.',
    inputSchema: dateParserInputSchema,
    execute: async (input) => {
      const { text, referenceDate } = input;
      try {
        const refDate = referenceDate ? new Date(referenceDate) : options.referenceDate || new Date();
        const chronoOptions: { forwardDate: boolean } = { forwardDate: options.forwardDate ?? true };

        const results = chrono.parse(text, refDate, chronoOptions);

        if (results.length === 0) {
          return { success: false, error: 'No dates found', text } as const;
        }

        const result = results[0];
        const confidence = result.text.length / text.trim().length;

        // IMPORTANT: Tool outputs must be JSON-serializable because providers may embed tool
        // results into the prompt. Never return Date objects here.
        const parsedDateISO = result.date().toISOString();

        return {
          success: true,
          input: text,
          parsed: {
            date: parsedDateISO,
            text: result.text,
            confidence: Math.min(confidence, 1.0),
            start: result.index,
            end: result.index + result.text.length,
          },
          startDate: result.start?.date()?.toISOString(),
          endDate: result.end?.date()?.toISOString(),
        } as const;
      } catch (err) {
        const error = err as Error;
        return { success: false, error: error.message, text } as const;
      }
    },
  });
}

export function parseDate(
  text: string,
  options: DateParserOptions = {}
): { date?: Date; text: string; confidence: number } | null {
  try {
    const refDate = options.referenceDate || new Date();
    const results = chrono.parse(text, refDate, { forwardDate: options.forwardDate ?? true });

    if (results.length === 0) return null;

    const result = results[0];
    return {
      date: result.date(),
      text: result.text,
      confidence: Math.min(result.text.length / text.trim().length, 1.0),
    };
  } catch {
    return null;
  }
}

export function parseDateRange(
  text: string,
  options: DateParserOptions = {}
): { start?: Date; end?: Date; text: string } | null {
  try {
    const refDate = options.referenceDate || new Date();
    const results = chrono.parse(text, refDate, { forwardDate: options.forwardDate ?? true });

    if (results.length === 0) return null;

    const result = results[0];
    return {
      start: result.start?.date(),
      end: result.end?.date(),
      text: result.text,
    };
  } catch {
    return null;
  }
}

export function formatDateForSpeech(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatTimeForSpeech(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export const commonDateExpressions = [
  'tomorrow',
  'next Friday',
  'this weekend',
  'March 15th',
  'in 3 days',
  'last week',
  'next month',
  'today at 3pm',
  'tomorrow morning',
  'Friday afternoon',
] as const;

export const dateParser: Tool<DateParserInput, DateParserOutput> = createDateParser({ forwardDate: true });
