import type { AuditListOptions, ConversationAuditEntry } from './types.js';

export function filterAuditEntries(
  entries: ConversationAuditEntry[],
  opts: AuditListOptions = {},
): ConversationAuditEntry[] {
  const types = opts.types && opts.types.length > 0 ? new Set(opts.types) : undefined;
  const from = opts.from?.getTime();
  const to = opts.to?.getTime();

  return entries
    .filter((entry) => !types || types.has(entry.type))
    .filter((entry) => {
      const at = Date.parse(entry.at);
      if (Number.isNaN(at)) return false;
      if (from !== undefined && at < from) return false;
      if (to !== undefined && at > to) return false;
      return true;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
