import { readdir, readFile } from 'fs/promises';
import { resolve } from 'path';
import type { TranscriptEvent } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function toTranscriptEvent(value: unknown, source: string, line: number): TranscriptEvent {
  if (!isRecord(value)) {
    throw new Error(`Invalid transcript payload at ${source}:${line} (expected object)`);
  }
  if (typeof value.sessionId !== 'string') {
    throw new Error(`Invalid transcript payload at ${source}:${line} (missing sessionId)`);
  }
  if (typeof value.agentId !== 'string') {
    throw new Error(`Invalid transcript payload at ${source}:${line} (missing agentId)`);
  }
  if (typeof value.timestamp !== 'string') {
    throw new Error(`Invalid transcript payload at ${source}:${line} (missing timestamp)`);
  }
  if (!isRecord(value.part) || typeof value.part.type !== 'string') {
    throw new Error(`Invalid transcript payload at ${source}:${line} (missing part.type)`);
  }

  const event: TranscriptEvent = {
    sessionId: value.sessionId,
    agentId: value.agentId,
    timestamp: value.timestamp,
    part: value.part as TranscriptEvent['part'],
  };
  if (typeof value.fullText === 'string') {
    event.fullText = value.fullText;
  }
  return event;
}

export async function readTranscriptFile(path: string): Promise<TranscriptEvent[]> {
  const absolutePath = resolve(path);
  const text = await readFile(absolutePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const events: TranscriptEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid JSON at ${absolutePath}:${i + 1}: ${(error as Error).message}`
      );
    }
    events.push(toTranscriptEvent(parsed, absolutePath, i + 1));
  }

  return events;
}

export async function listTranscriptFiles(directory: string): Promise<string[]> {
  const absoluteDirectory = resolve(directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => resolve(absoluteDirectory, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export async function readTranscriptDirectory(directory: string): Promise<TranscriptEvent[]> {
  const files = await listTranscriptFiles(directory);
  const allEvents: TranscriptEvent[] = [];
  for (const file of files) {
    const events = await readTranscriptFile(file);
    allEvents.push(...events);
  }
  allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return allEvents;
}
