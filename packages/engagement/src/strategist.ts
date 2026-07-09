import type { OutboundTemplate, WindowState } from '@kuralle-agents/messaging';

export interface TemplateDescriptor {
  name: string;
  language: string;
  category: 'authentication' | 'marketing' | 'utility';
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  quality: 'GREEN' | 'YELLOW' | 'RED' | 'PAUSED' | 'DISABLED' | 'UNKNOWN';
  params: { key: string; required: boolean }[];
}

export type DeferReason =
  | 'no-approved-template'
  | 'no-template-fit'
  | 'param-validation-failed'
  | 'selector-error'
  | (string & {});

export interface ConversionAudit {
  requestedText: string;
  chosenTemplate: string;
  params: Record<string, string>;
  at: number;
}

export type SendDecision =
  | { kind: 'freeform'; text: string }
  | {
      kind: 'template';
      template: OutboundTemplate;
      selected: TemplateDescriptor;
      audit: ConversionAudit;
    }
  | { kind: 'defer'; reason: DeferReason };

export interface StrategistInput {
  text: string;
  window: WindowState;
  intent?: string;
  flowState?: Readonly<Record<string, unknown>>;
}

export interface TemplateSelector {
  select(input: {
    text: string;
    intent?: string;
    candidates: readonly TemplateDescriptor[];
    flowState?: Readonly<Record<string, unknown>>;
  }): Promise<{ name: string; language: string; params: Record<string, string> } | null>;
}

export interface TemplateCatalog {
  approved(): Promise<TemplateDescriptor[]>;
  validateParams(
    name: string,
    p: Record<string, string>,
  ): { ok: boolean; errors?: string[] };
}

export interface AuditSink {
  record(a: ConversionAudit): Promise<void> | void;
}

export interface SmartSendStrategist {
  decide(input: StrategistInput): Promise<SendDecision>;
}

export function createSmartSendStrategist(opts: {
  catalog: TemplateCatalog;
  selector: TemplateSelector;
  audit: AuditSink;
}): SmartSendStrategist {
  const { catalog, selector, audit } = opts;

  return {
    async decide(input: StrategistInput): Promise<SendDecision> {
      if (input.window.open) {
        return { kind: 'freeform', text: input.text };
      }

      const candidates = await catalog.approved();
      if (candidates.length === 0) {
        return { kind: 'defer', reason: 'no-approved-template' };
      }

      let pick: { name: string; language: string; params: Record<string, string> } | null;
      try {
        pick = await selector.select({
          text: input.text,
          intent: input.intent,
          candidates,
          flowState: input.flowState,
        });
      } catch {
        return { kind: 'defer', reason: 'selector-error' };
      }

      if (pick == null) {
        return { kind: 'defer', reason: 'no-template-fit' };
      }

      const selected = candidates.find((c) => c.name === pick!.name);
      if (!selected) {
        return { kind: 'defer', reason: 'no-template-fit' };
      }

      const v = catalog.validateParams(pick.name, pick.params);
      if (!v.ok) {
        return { kind: 'defer', reason: 'param-validation-failed' };
      }

      const conversionAudit: ConversionAudit = {
        requestedText: input.text,
        chosenTemplate: pick.name,
        params: pick.params,
        at: Date.now(),
      };
      await audit.record(conversionAudit);

      const template: OutboundTemplate = {
        name: pick.name,
        language: pick.language,
        namedParams: pick.params,
      };

      return {
        kind: 'template',
        template,
        selected,
        audit: conversionAudit,
      };
    },
  };
}
