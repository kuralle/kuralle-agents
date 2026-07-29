"use client";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolPart } from '@/components/ai-elements/tool';
import { Button } from '@/components/ui/button';
import type { HitlInterrupt, KuralleUIMessage } from '@kuralle-agents/core';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, isToolUIPart } from 'ai';
import { BookOpen, Check, Database, Fingerprint, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface BootstrapData {
  profile: { name: string | null; email: string | null; preferences: Record<string, string>; lastSeenAt: string };
  memories: Array<{ memoryType: string; content: string; updatedAt: string }>;
  newIdentity: boolean;
  driver: 'pi' | 'ai-sdk';
}

const SUGGESTIONS = [
  'How do durable approvals prevent duplicate effects?',
  'Look up order_1001 for me.',
  'Remember that my preferred editor is Neovim.',
  'What do you remember about me?',
] as const;

export function Workbench() {
  const [conversationId] = useState(() => `web_${crypto.randomUUID()}`);
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [pending, setPending] = useState<HitlInterrupt>();
  const [approvalBusy, setApprovalBusy] = useState(false);
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/chat' }), []);

  const { messages, sendMessage, setMessages, status, stop, error, clearError } = useChat<KuralleUIMessage>({
    id: conversationId,
    transport,
    onData: (part) => {
      if (part.type !== 'data-kuralle-control' || part.data.event !== 'paused' || !part.data.interrupt) return;
      setPending(part.data.interrupt);
    },
  });

  const loadBootstrap = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/bootstrap', { signal, credentials: 'same-origin' });
    const body = await response.json() as BootstrapData & { error?: string };
    if (!response.ok) throw new Error(body.error || 'Could not initialize the workbench.');
    setBootstrap(body);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadBootstrap(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setBootstrapError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [loadBootstrap]);

  const submit = useCallback(async ({ text }: PromptInputMessage) => {
    if (!text.trim() || pending) return;
    clearError();
    await sendMessage({ text: text.trim() });
  }, [clearError, pending, sendMessage]);

  const decide = useCallback(async (decision: 'approve' | 'deny') => {
    if (!pending || approvalBusy) return;
    setApprovalBusy(true);
    try {
      const response = await fetch('/api/chat/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          conversationId,
          requestId: pending.requestId,
          name: pending.signalName,
          decision,
        }),
      });
      const body = await response.json() as { text?: string; pending?: HitlInterrupt; error?: string };
      if (!response.ok) throw new Error(body.error || 'The decision could not be delivered.');
      setPending(body.pending);
      if (body.text?.trim()) {
        setMessages((current) => [...current, {
          id: crypto.randomUUID(),
          role: 'assistant',
          parts: [{ type: 'text', text: body.text!.trim() }],
        }]);
      }
      await loadBootstrap();
    } catch (cause) {
      setBootstrapError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApprovalBusy(false);
    }
  }, [approvalBusy, conversationId, loadBootstrap, pending, setMessages]);

  const busy = status === 'submitted' || status === 'streaming';

  return (
    <main className="paper-noise min-h-dvh p-3 md:p-6">
      <div className="mx-auto grid min-h-[calc(100dvh-3rem)] w-full min-w-0 max-w-[1500px] grid-cols-1 overflow-hidden border-2 border-foreground bg-card shadow-[10px_10px_0_#171b24] lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex flex-col border-b-2 border-foreground bg-[#e8e0cf] lg:border-r-2 lg:border-b-0">
          <div className="border-b-2 border-foreground bg-primary p-4 text-primary-foreground lg:p-5">
            <div className="mb-3 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.2em] lg:mb-8">
              <span>Field system 01</span>
              <span className="flex items-center gap-1.5"><span className="size-2 bg-accent" /> online</span>
            </div>
            <h1 className="font-[family-name:var(--font-display)] text-4xl leading-[0.86] tracking-[-0.055em] lg:text-5xl">Field<span className="lg:block"> Notes</span></h1>
            <p className="mt-5 hidden max-w-[24ch] text-xs leading-5 opacity-80 lg:block">A durable research desk with local Postgres memory.</p>
          </div>

          <section className="grid grid-cols-2 border-b-2 border-foreground text-[10px] uppercase tracking-[0.12em]">
            <div className="border-r border-foreground p-3"><span className="block text-muted-foreground">Driver</span><strong>{bootstrap?.driver === 'ai-sdk' ? 'AI SDK' : 'PI'}</strong></div>
            <div className="p-3"><span className="block text-muted-foreground">Store</span><strong>Postgres</strong></div>
          </section>

          <section className="hidden p-4 lg:block">
            <p className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]"><Fingerprint className="size-3.5" /> Private identity</p>
            {bootstrap ? (
              <div className="space-y-2 border border-foreground/40 bg-card p-3 text-xs">
                <p className="font-semibold">{bootstrap.profile.name || 'Anonymous researcher'}</p>
                <p className="truncate text-muted-foreground">{bootstrap.profile.email || 'No email stored'}</p>
                <p className="pt-1 text-[10px] uppercase tracking-widest text-primary">signed HTTP-only cookie</p>
              </div>
            ) : <div className="h-20 animate-pulse border border-foreground/30 bg-muted" />}
          </section>

          <section className="hidden min-h-0 flex-1 border-t border-foreground/30 p-4 lg:block">
            <div className="mb-3 flex items-center justify-between">
              <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]"><Database className="size-3.5" /> Memory slots</p>
              <span className="bg-foreground px-1.5 py-0.5 text-[10px] text-card">{bootstrap?.memories.length ?? 0}</span>
            </div>
            <div className="space-y-2">
              {bootstrap?.memories.slice(0, 5).map((memory) => (
                <div key={memory.memoryType} className="border-l-2 border-primary pl-2 text-xs">
                  <p className="font-semibold text-primary">{memory.memoryType}</p>
                  <p className="line-clamp-2 text-muted-foreground">{memory.content}</p>
                </div>
              ))}
              {bootstrap?.memories.length === 0 ? <p className="text-xs leading-5 text-muted-foreground">Nothing saved yet. Writes pause for your approval.</p> : null}
            </div>
          </section>

          <footer className="hidden border-t-2 border-foreground p-4 text-[10px] leading-4 text-muted-foreground lg:block">
            <ShieldCheck className="mb-2 size-4 text-primary" />
            User IDs never enter the client payload. Conversations are namespaced server-side.
          </footer>
        </aside>

        <section className="flex min-h-[680px] min-w-0 flex-col bg-card">
          <header className="flex items-center justify-between border-b-2 border-foreground px-4 py-3 md:px-6">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Retrieval-led dialogue</p>
              <h2 className="font-[family-name:var(--font-display)] text-2xl font-semibold">Research desk</h2>
            </div>
            <div className="flex items-center gap-2 border border-foreground px-2.5 py-1 text-[10px] uppercase tracking-wider">
              <span className={`size-2 ${busy ? 'animate-pulse bg-primary' : 'bg-accent ring-1 ring-foreground'}`} />
              {busy ? 'working' : pending ? 'approval needed' : 'ready'}
            </div>
          </header>

          <Conversation className="min-h-0">
            <ConversationContent className="mx-auto w-full max-w-4xl gap-7 px-4 py-8 md:px-8">
              {messages.length === 0 ? (
                <ConversationEmptyState className="min-h-[420px] items-start justify-center text-left" icon={<BookOpen className="size-9 text-primary" />}>
                  <div className="w-full min-w-0 max-w-2xl rise">
                    <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Notebook open</p>
                    <h3 className="font-[family-name:var(--font-display)] text-5xl leading-[0.95] tracking-[-0.04em] md:text-7xl">Ask the system,<br /><em>then inspect its work.</em></h3>
                    <p className="mt-5 max-w-[56ch] text-sm leading-6 text-muted-foreground">Every answer retrieves from the local corpus. Profile and memory writes become durable, reviewable approvals.</p>
                    <div className="mt-8 grid min-w-0 gap-2 sm:grid-cols-2">
                      {SUGGESTIONS.map((suggestion, index) => (
                        <button key={suggestion} type="button" onClick={() => sendMessage({ text: suggestion })} className="group min-w-0 break-words border border-foreground bg-card p-3 text-left text-xs transition-[transform,background-color] hover:-translate-y-0.5 hover:bg-accent disabled:opacity-40" disabled={busy || Boolean(pending)}>
                          <span className="mr-2 text-primary">0{index + 1}</span>{suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                </ConversationEmptyState>
              ) : messages.map((message) => (
                <Message from={message.role} key={message.id} className="rise">
                  <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{message.role === 'user' ? 'You / input' : 'Field Notes / response'}</div>
                  <MessageContent className={message.role === 'user' ? 'border border-foreground bg-foreground text-card' : 'w-full'}>
                    {message.parts.map((part, index) => {
                      if (part.type === 'text') return message.role === 'assistant'
                        ? <MessageResponse key={index}>{part.text}</MessageResponse>
                        : <p key={index} className="whitespace-pre-wrap leading-6">{part.text}</p>;
                      if (isToolUIPart(part)) return <ToolCard key={index} part={part as ToolPart} />;
                      return null;
                    })}
                  </MessageContent>
                </Message>
              ))}

              {pending ? <ApprovalCard pending={pending} busy={approvalBusy} onDecision={decide} /> : null}
              {error || bootstrapError ? (
                <div role="alert" className="border-2 border-destructive bg-[#fff0e5] p-4 text-sm text-destructive">
                  <strong className="block uppercase tracking-wider">Request interrupted</strong>
                  {error?.message || bootstrapError}
                </div>
              ) : null}
            </ConversationContent>
            <ConversationScrollButton className="border-foreground bg-accent text-accent-foreground" />
          </Conversation>

          <div className="border-t-2 border-foreground bg-[#e8e0cf] p-3 md:p-5">
            <PromptInput onSubmit={submit} className="mx-auto max-w-4xl border-2 border-foreground bg-card shadow-[4px_4px_0_#171b24]" accept="text/*">
              <PromptInputBody>
                <PromptInputTextarea aria-label="Message Field Notes" disabled={Boolean(pending)} placeholder={pending ? 'Review the pending operation first…' : 'Ask a grounded question or manage a memory…'} className="min-h-20 text-sm" />
              </PromptInputBody>
              <PromptInputFooter className="border-t border-foreground/30">
                <PromptInputTools><span className="px-2 text-[9px] uppercase tracking-[0.15em] text-muted-foreground">retrieval · identity scope · durable trace</span></PromptInputTools>
                <PromptInputSubmit status={status} onStop={stop} disabled={Boolean(pending)} className="rounded-none bg-primary text-primary-foreground" />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </section>
      </div>
    </main>
  );
}

function ToolCard({ part }: { part: ToolPart }) {
  const dynamic = part.type === 'dynamic-tool';
  return (
    <Tool className="border-foreground/40 bg-[#eee8d9]" defaultOpen={part.state === 'output-error'}>
      {dynamic
        ? <ToolHeader type="dynamic-tool" toolName={part.toolName} state={part.state} />
        : <ToolHeader type={part.type} state={part.state} />}
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={'output' in part ? part.output : undefined} errorText={'errorText' in part ? part.errorText : undefined} />
      </ToolContent>
    </Tool>
  );
}

function ApprovalCard({ pending, busy, onDecision }: {
  pending: HitlInterrupt;
  busy: boolean;
  onDecision: (decision: 'approve' | 'deny') => void;
}) {
  return (
    <div className="rise border-2 border-foreground bg-accent p-4 shadow-[6px_6px_0_#1546d2] md:p-5">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]">Human checkpoint</p>
          <h3 className="mt-1 font-[family-name:var(--font-display)] text-2xl font-semibold">{pending.display.title}</h3>
          {pending.display.description ? <p className="mt-1 text-xs leading-5">{pending.display.description}</p> : null}
          {pending.operation ? <pre className="mt-3 overflow-auto border border-foreground/40 bg-card/70 p-3 text-[10px]">{JSON.stringify({ tool: pending.operation.toolName, input: pending.operation.args }, null, 2)}</pre> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" onClick={() => onDecision('approve')} disabled={busy} className="rounded-none border border-foreground bg-foreground text-card"><Check className="size-4" /> Approve exact operation</Button>
            <Button type="button" onClick={() => onDecision('deny')} disabled={busy} variant="outline" className="rounded-none border-foreground bg-transparent"><X className="size-4" /> Deny</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
