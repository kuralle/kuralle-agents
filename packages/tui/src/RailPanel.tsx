import type { TurnView } from '@kuralle-agents/client';
import type { MemorySnapshot } from './memoryTypes.js';
import { syntaxStyle } from './syntaxStyle.js';
import { spanKindColor, traceSpansFromView, traceTokenLine } from './traceRail.js';

export type RailTab = 'trace' | 'memory';

function jsonLine(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function TraceTab({ view }: { view: TurnView }) {
  const spans = traceSpansFromView(view);
  const tokens = traceTokenLine(view);
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1 }}>
      {spans.length === 0 ? (
        <text style={{ fg: '#565f89' }} content="run a turn to see its trace…" />
      ) : (
        spans.map((span) => (
          <text
            key={span.id}
            style={{ fg: spanKindColor(span.kind) }}
            content={`${'  '.repeat(span.depth)}${span.error ? '✖ ' : ''}${span.name}${span.ms !== null ? ` · ${span.ms}ms` : ''}`}
          />
        ))
      )}
      {tokens ? (
        <box style={{ marginTop: 1, flexDirection: 'column' }}>
          <text style={{ fg: '#7dcfff' }} content={tokens} />
        </box>
      ) : null}
    </box>
  );
}

function MemoryTab({
  view,
  snapshot,
  memoryConfigured,
  userId,
}: {
  view: TurnView;
  snapshot: MemorySnapshot | null;
  memoryConfigured: boolean;
  userId?: string;
}) {
  if (memoryConfigured && !userId) {
    return (
      <text
        style={{ fg: '#e0af68' }}
        content="memory is off — pass --user to scope preload, extractors, and the USER block"
      />
    );
  }

  const changedSlugs = new Set(view.memory.extracted.map((entry) => entry.slug));

  return (
    <scrollbox style={{ flexGrow: 1 }} focused={false}>
      <box style={{ flexDirection: 'column' }}>
        <text style={{ fg: '#565f89' }} content="working memory" />
        {(snapshot?.blocks ?? []).length === 0 ? (
          <text style={{ fg: '#565f89' }} content="(no blocks)" />
        ) : (
          (snapshot?.blocks ?? []).map((block) => (
            <box key={`${block.scope}:${block.key}`} style={{ flexDirection: 'column', marginBottom: 1 }}>
              <text
                style={{ fg: '#9ece6a' }}
                content={`${block.key} · ${block.chars}/${block.limit} chars`}
              />
              {block.content ? (
                <code
                  content={block.content}
                  syntaxStyle={syntaxStyle}
                  filetype="markdown"
                  width="100%"
                />
              ) : null}
            </box>
          ))
        )}
        <text style={{ fg: '#565f89', marginTop: 1 }} content="extracted" />
        {(snapshot?.extracted ?? []).length === 0 && view.memory.extracted.length === 0 ? (
          <text style={{ fg: '#565f89' }} content="(none)" />
        ) : (
          (snapshot?.extracted ?? []).map((entry) => (
            <box key={entry.slug} style={{ flexDirection: 'column', marginBottom: 1 }}>
              <text
                style={{ fg: changedSlugs.has(entry.slug) ? '#c9ff35' : '#7aa2f7' }}
                content={`${entry.slug}${changedSlugs.has(entry.slug) ? ' · changed' : ''} · ${entry.updatedAt}`}
              />
              <code
                content={jsonLine(entry.value)}
                syntaxStyle={syntaxStyle}
                filetype="json"
                width="100%"
              />
            </box>
          ))
        )}
        {view.memory.extracted
          .filter((entry) => !(snapshot?.extracted ?? []).some((stored) => stored.slug === entry.slug))
          .map((entry) => (
            <box key={`live-${entry.slug}`} style={{ flexDirection: 'column', marginBottom: 1 }}>
              <text
                style={{ fg: '#c9ff35' }}
                content={`${entry.slug} · changed · turn+${entry.at}ms`}
              />
              <code
                content={jsonLine(entry.value)}
                syntaxStyle={syntaxStyle}
                filetype="json"
                width="100%"
              />
            </box>
          ))}
        {view.memory.compactions.length > 0 ? (
          <>
            <text style={{ fg: '#565f89', marginTop: 1 }} content="compactions" />
            {view.memory.compactions.map((compaction, index) => (
              <text
                key={`compaction-${index}`}
                style={{ fg: '#bb9af7' }}
                content={`${compaction.beforeTokens}→${compaction.afterTokens} tok · summarized ${compaction.summarizedCount}`}
              />
            ))}
          </>
        ) : null}
      </box>
    </scrollbox>
  );
}

export function RailPanel({
  tab,
  view,
  memorySnapshot,
  memoryConfigured,
  userId,
}: {
  tab: RailTab;
  view: TurnView;
  memorySnapshot: MemorySnapshot | null;
  memoryConfigured: boolean;
  userId?: string;
}) {
  const title = tab === 'trace' ? 'Trace ^t' : 'Memory ^m';
  return (
    <box
      title={title}
      style={{
        width: 40,
        border: true,
        flexDirection: 'column',
        padding: 1,
      }}
    >
      <box style={{ flexDirection: 'row', marginBottom: 1 }}>
        <text
          style={{ fg: tab === 'trace' ? '#7aa2f7' : '#565f89' }}
          content="Trace"
        />
        <text content=" · " />
        <text
          style={{ fg: tab === 'memory' ? '#7aa2f7' : '#565f89' }}
          content="Memory"
        />
      </box>
      {tab === 'trace' ? (
        <TraceTab view={view} />
      ) : (
        <MemoryTab
          view={view}
          snapshot={memorySnapshot}
          memoryConfigured={memoryConfigured}
          userId={userId}
        />
      )}
    </box>
  );
}
