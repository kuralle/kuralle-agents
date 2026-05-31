import type { ChannelId } from '../types/session.js';

export interface ChannelPolicy {
  readonly channelId: ChannelId;
  readonly stripMarkdown?: boolean;
  readonly stripEmojis?: boolean;
  readonly maxLengthChars?: number;
  readonly voiceMode?: boolean;
  readonly renderCitations?: 'inline' | 'footnotes' | 'off';
  readonly customRenderer?: (text: string) => string;
}
