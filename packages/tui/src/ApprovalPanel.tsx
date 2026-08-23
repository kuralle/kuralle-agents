import { useMemo } from 'react';
import type { SelectOption } from '@opentui/core';
import type { PendingInterrupt } from './approvalRespond.js';
import { syntaxStyle } from './syntaxStyle.js';

function jsonBlock(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDeadline(deadline: number): string {
  return new Date(deadline).toLocaleString();
}

function deadlineHint(deadline: number | null): string | null {
  if (deadline === null) return null;
  if (Date.now() > deadline) {
    return 'Deadline passed — the run will be denied automatically (deadline-expired).';
  }
  return `Decide before ${formatDeadline(deadline)} or the run is denied automatically (deadline-expired).`;
}

export function ApprovalPanel({
  interrupt,
  inspecting,
  onDecision,
  onInspect,
}: {
  interrupt: PendingInterrupt;
  inspecting: boolean;
  onDecision: (decision: 'approve' | 'deny') => void;
  onInspect: () => void;
}) {
  const toolName = interrupt.operation?.toolName ?? interrupt.display.title;
  const args = interrupt.operation?.args;
  const hint = deadlineHint(interrupt.deadline);

  const options = useMemo((): SelectOption[] => {
    const items: SelectOption[] = [];
    if (interrupt.allowedDecisions.includes('approve')) {
      items.push({
        name: 'Approve',
        description: 'Run the tool with these arguments',
        value: 'approve',
      });
    }
    if (interrupt.allowedDecisions.includes('deny')) {
      items.push({
        name: 'Deny',
        description: 'Reject the tool call',
        value: 'deny',
      });
    }
    items.push({
      name: 'Inspect',
      description: 'View the full argument payload',
      value: 'inspect',
    });
    return items;
  }, [interrupt.allowedDecisions]);

  return (
    <box
      title="Approval required"
      style={{
        border: true,
        flexDirection: 'column',
        padding: 1,
        marginBottom: 1,
      }}
    >
      <text style={{ fg: '#e0af68' }} content={toolName} />
      {interrupt.display.description ? (
        <text style={{ fg: '#565f89' }} content={interrupt.display.description} />
      ) : null}
      {args !== undefined ? (
        <code
          content={jsonBlock(args)}
          syntaxStyle={syntaxStyle}
          filetype="json"
          width="100%"
        />
      ) : null}
      {inspecting && args !== undefined ? (
        <box style={{ flexDirection: 'column', marginTop: 1 }}>
          <text style={{ fg: '#7aa2f7' }} content="Full arguments" />
          <code
            content={jsonBlock(args)}
            syntaxStyle={syntaxStyle}
            filetype="json"
            width="100%"
          />
        </box>
      ) : null}
      {hint ? <text style={{ fg: '#bb9af7' }} content={hint} /> : null}
      <select
        focused
        options={options}
        style={{ height: Math.min(8, options.length * 2 + 1) }}
        onSelect={(_index, option) => {
          const value = option?.value;
          if (value === 'approve' || value === 'deny') {
            onDecision(value);
            return;
          }
          if (value === 'inspect') onInspect();
        }}
      />
    </box>
  );
}
