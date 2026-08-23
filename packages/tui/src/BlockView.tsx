import type { Block } from '@kuralle-agents/client';
import { syntaxStyle } from './syntaxStyle.js';

function jsonBlock(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'user':
      return (
        <box style={{ flexDirection: 'column', marginBottom: 1 }}>
          <text style={{ fg: '#7dcfff' }} content="You" />
          <text content={block.text} />
        </box>
      );
    case 'assistant':
      return (
        <box style={{ flexDirection: 'column', marginBottom: 1 }}>
          <text style={{ fg: '#9ece6a' }} content="Agent" />
          <markdown
            content={block.text}
            syntaxStyle={syntaxStyle}
            streaming={true}
            width="100%"
          />
          {block.streaming ? <text content="▌" /> : null}
        </box>
      );
    case 'tool':
      return (
        <box style={{ flexDirection: 'column', marginBottom: 1 }}>
          <text style={{ fg: '#e0af68' }} content={`⚙ ${block.name} (${block.state})`} />
          <code
            content={jsonBlock(block.args)}
            syntaxStyle={syntaxStyle}
            filetype="json"
            width="100%"
          />
          {block.result !== undefined ? (
            <code
              content={jsonBlock(block.result)}
              syntaxStyle={syntaxStyle}
              filetype="json"
              width="100%"
            />
          ) : null}
        </box>
      );
    case 'flow':
      return (
        <text
          style={{ fg: '#bb9af7' }}
          content={`flow ${block.phase}: ${block.flow}${block.node ? ` · ${block.node}` : ''}`}
        />
      );
    case 'handoff':
      return (
        <text
          style={{ fg: '#7aa2f7' }}
          content={`→ handoff ${block.to}${block.reason ? `: ${block.reason}` : ''}`}
        />
      );
    case 'notice': {
      const color = block.level === 'error' ? '#f7768e' : block.level === 'warn' ? '#e0af68' : '#565f89';
      return <text style={{ fg: color }} content={block.text} />;
    }
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}
