import type { ChannelId } from '../types/session.js';
import type { ChannelPolicy } from './types.js';
import { getDefaultChannelPolicy } from './defaultPolicies.js';

export type ChannelPolicyChange = 'strip-markdown' | 'strip-emojis' | 'truncate' | 'custom';

export interface ChannelPolicyResult {
  text: string;
  changes: ChannelPolicyChange[];
  beforeLen: number;
  afterLen: number;
}

export function resolveChannelPolicy(
  channelId: ChannelId,
  policies: readonly ChannelPolicy[] = [],
): ChannelPolicy {
  return policies.find(policy => policy.channelId === channelId) ?? getDefaultChannelPolicy(channelId);
}

export function applyChannelPolicy(text: string, policy: ChannelPolicy): ChannelPolicyResult {
  const beforeLen = text.length;
  const changes: ChannelPolicyChange[] = [];
  let current = text;

  if (policy.stripMarkdown) {
    const next = stripMarkdown(current);
    if (next !== current) {
      current = next;
      changes.push('strip-markdown');
    }
  }

  if (policy.stripEmojis) {
    const next = stripEmojis(current);
    if (next !== current) {
      current = next;
      changes.push('strip-emojis');
    }
  }

  if (policy.maxLengthChars !== undefined && current.length > policy.maxLengthChars) {
    current = truncateText(current, policy.maxLengthChars);
    changes.push('truncate');
  }

  if (policy.customRenderer) {
    const next = policy.customRenderer(current);
    if (next !== current) {
      current = next;
      changes.push('custom');
    }
  }

  return {
    text: current,
    changes,
    beforeLen,
    afterLen: current.length,
  };
}

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/[*_`~>#-]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function stripEmojis(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function truncateText(text: string, maxLengthChars: number): string {
  if (maxLengthChars <= 0) return '';
  if (maxLengthChars <= 3) return '.'.repeat(maxLengthChars);
  return `${text.slice(0, maxLengthChars - 3)}...`;
}
