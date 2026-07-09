import type { ChannelId } from '../types/session.js';
import type { ChannelPolicy } from './types.js';

export const DEFAULT_CHANNEL_POLICIES: readonly ChannelPolicy[] = [
  { channelId: 'web', stripMarkdown: false, stripEmojis: false, voiceMode: false },
  { channelId: 'email', stripMarkdown: false, stripEmojis: false },
  { channelId: 'sms', stripMarkdown: true, stripEmojis: true, maxLengthChars: 1500, renderCitations: 'off' },
  { channelId: 'voice', stripMarkdown: true, stripEmojis: true, voiceMode: true, renderCitations: 'off' },
] as const;

export function getDefaultChannelPolicy(channelId: ChannelId): ChannelPolicy {
  return DEFAULT_CHANNEL_POLICIES.find(policy => policy.channelId === channelId)
    ?? { channelId, stripMarkdown: false, stripEmojis: false };
}
