const ABBREVIATIONS = [
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'st.',
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'no.',
] as const;

const TERMINAL_PUNCT_RE = /(?:\.{3}|[!?]+|\.)/g;

const MIN_WORDS_TO_CONFIRM_PERIOD_AT_TOKEN_END = 3;

function hasWordCharBefore(text: string, index: number): boolean {
  return index > 0 && /\w/.test(text[index - 1]!);
}

function isDecimalPeriod(text: string, periodIndex: number): boolean {
  if (text[periodIndex] !== '.') return false;
  const before = periodIndex > 0 ? text[periodIndex - 1] : '';
  const after = periodIndex < text.length - 1 ? text[periodIndex + 1] : '';
  return /\d/.test(before) && /\d/.test(after);
}

function isAbbreviationPeriod(text: string, periodIndex: number): boolean {
  if (text[periodIndex] !== '.') return false;
  const prefix = text.slice(0, periodIndex + 1).toLowerCase();
  for (const abbr of ABBREVIATIONS) {
    if (prefix.endsWith(abbr)) {
      const start = prefix.length - abbr.length;
      if (!hasWordCharBefore(prefix, start)) return true;
    }
    for (let len = 1; len < abbr.length; len++) {
      const partial = abbr.slice(0, len);
      if (!partial.endsWith('.')) continue;
      if (!prefix.endsWith(partial)) continue;
      const start = prefix.length - partial.length;
      if (!hasWordCharBefore(prefix, start)) return true;
    }
  }
  return false;
}

function endsWithSentencePunctuation(text: string): boolean {
  if (/[!?]+$/.test(text)) return true;
  if (/\.{3,}$/.test(text)) return true;
  if (/\.$/.test(text) && !/\.{2,}$/.test(text)) return true;
  return false;
}

function endsWithIncompleteEllipsis(text: string): boolean {
  return /\.{2}$/.test(text) && !/\.{3,}$/.test(text);
}

function remainderStartsNewSentence(text: string, endIndex: number): boolean {
  const rest = text.slice(endIndex);
  return /^\s*$/.test(rest) || /^\s+[A-Z]/.test(rest);
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function isValidSentenceEnd(text: string, endIndex: number): boolean {
  const punct = text.slice(0, endIndex).match(/(?:\.{3}|[!?]+|\.)$/)?.[0];
  if (!punct) return false;
  const periodIndex = endIndex - punct.length;
  if (punct === '.' || (punct.startsWith('.') && punct.length === 1)) {
    if (endIndex < text.length && text[endIndex] === '.') return false;
    if (isDecimalPeriod(text, periodIndex)) return false;
    if (isAbbreviationPeriod(text, periodIndex)) return false;
  }
  if (endIndex === text.length && endsWithIncompleteEllipsis(text.slice(0, endIndex))) {
    return false;
  }
  return true;
}

export function matchEndOfSentence(text: string): number {
  if (!text) return 0;

  TERMINAL_PUNCT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TERMINAL_PUNCT_RE.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (!isValidSentenceEnd(text, end)) continue;
    if (remainderStartsNewSentence(text, end)) return end;
  }

  if (endsWithIncompleteEllipsis(text)) return 0;
  const trailing = text.match(/(?:\.{3}|[!?]+|\.)$/);
  if (trailing && isValidSentenceEnd(text, text.length)) return text.length;
  return 0;
}

export class SentenceAggregator {
  private buffer = '';
  private needsLookahead = false;
  private pendingPeriodConfirm = false;

  push(tokenText: string): string[] {
    if (tokenText === '') return [];
    if (/^\s+$/.test(tokenText)) {
      this.buffer += tokenText;
      return [];
    }

    const sentences: string[] = [];
    if (this.pendingPeriodConfirm) {
      const confirmed = this.confirmPendingPeriod(tokenText[0]!);
      if (confirmed !== null) sentences.push(confirmed);
    }

    for (const char of tokenText) {
      this.buffer += char;
      const completed = this.checkSentenceWithLookahead(char);
      if (completed !== null) sentences.push(completed);
    }

    const drained = this.drainConfirmedAtBufferEnd();
    if (drained !== null) sentences.push(drained);
    return sentences;
  }

  flush(): string | null {
    if (this.buffer.length === 0) return null;
    const tail = this.buffer;
    this.buffer = '';
    this.needsLookahead = false;
    this.pendingPeriodConfirm = false;
    return tail;
  }

  private confirmPendingPeriod(nextChar: string): string | null {
    this.pendingPeriodConfirm = false;
    if (nextChar.trim() === '') {
      this.needsLookahead = false;
      return this.emitFirstSentenceIfFound();
    }
    this.needsLookahead = false;
    return null;
  }

  private checkSentenceWithLookahead(char: string): string | null {
    if (this.needsLookahead) {
      if (char.trim() !== '') {
        this.needsLookahead = false;
        this.pendingPeriodConfirm = false;
        return this.emitFirstSentenceIfFound();
      }
      return null;
    }

    if (this.buffer.length > 0 && endsWithSentencePunctuation(this.buffer)) {
      this.needsLookahead = true;
    }
    return null;
  }

  private drainConfirmedAtBufferEnd(): string | null {
    if (!this.needsLookahead) return null;

    if (this.buffer.endsWith('.') && !/\.{2,}$/.test(this.buffer)) {
      if (wordCount(this.buffer) < MIN_WORDS_TO_CONFIRM_PERIOD_AT_TOKEN_END) {
        this.pendingPeriodConfirm = true;
        return null;
      }
    }

    const end = matchEndOfSentence(this.buffer);
    if (end > 0 && end === this.buffer.length) {
      this.needsLookahead = false;
      this.pendingPeriodConfirm = false;
      const sentence = this.buffer.trimStart();
      this.buffer = '';
      return sentence.length > 0 ? sentence : null;
    }
    return null;
  }

  private emitFirstSentenceIfFound(): string | null {
    const end = matchEndOfSentence(this.buffer);
    if (end > 0) {
      const sentence = this.buffer.slice(0, end).trimStart();
      this.buffer = this.buffer.slice(end);
      return sentence.length > 0 ? sentence : null;
    }
    return null;
  }
}
