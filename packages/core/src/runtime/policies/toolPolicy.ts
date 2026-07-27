import type { AnyTool } from '../../types/effectTool.js';

/**
 * Whether a tool call runs, asks a human first, or is refused.
 *
 * `needsApproval?: boolean` on a tool answers exactly one question — "pause for a human?" —
 * and cannot express the things a governed run actually needs: a read-only worker, an
 * allowlist of shell commands, a spend lane that only gates above a threshold, or a rule
 * that depends on the arguments rather than the tool name. Those all want a decision
 * function, so the decision is the primitive and `needsApproval` becomes sugar over it.
 */
export type PolicyDecision =
  | { kind: 'allow' }
  /** Suspend durably and wait for a human. `title` is what they are shown. */
  | { kind: 'ask'; title?: string }
  /** Refuse without asking anyone. `reason` is surfaced to the model. */
  | { kind: 'deny'; reason: string };

export interface PolicyRequest {
  toolName: string;
  /** The arguments the model supplied. A policy may inspect them (paths, amounts, commands). */
  args: unknown;
  /** The tool definition, when the executor could resolve one — carries `needsApproval` etc. */
  def?: AnyTool;
}

/**
 * One method, deliberately. Everything a policy needs is in the request, and the only
 * output is the decision — so a policy cannot execute the tool, mutate the run, or become
 * a second place where control flow lives.
 */
export interface Policy {
  decide(req: PolicyRequest): PolicyDecision | Promise<PolicyDecision>;
}

export const ALLOW: PolicyDecision = { kind: 'allow' };

/**
 * The default, and the compatibility shim: a tool marked `needsApproval` asks, everything
 * else runs. This is exactly the behaviour every existing agent already has, so adding the
 * Policy seam changes nothing until someone supplies their own.
 */
export const needsApprovalPolicy: Policy = {
  decide: ({ toolName, def }) =>
    def?.needsApproval ? { kind: 'ask', title: `Approve tool: ${toolName}` } : ALLOW,
};

/** Denies every mutating call. A worker given this can inspect a workspace but not change it. */
export function readOnlyPolicy(mutatingTools: readonly string[]): Policy {
  const blocked = new Set(mutatingTools);
  return {
    decide: (req) =>
      blocked.has(req.toolName)
        ? { kind: 'deny', reason: `${req.toolName} is not available to a read-only agent.` }
        : needsApprovalPolicy.decide(req),
  };
}

/**
 * First policy to return a non-allow decision wins, in order. `deny` from an earlier policy
 * is not overridable by a later one — a composed policy can only ever be more restrictive
 * than its parts, which is the property that makes composition safe to reason about.
 */
export function composePolicies(...policies: readonly Policy[]): Policy {
  return {
    decide: async (req) => {
      let pending: PolicyDecision = ALLOW;
      for (const policy of policies) {
        const decision = await policy.decide(req);
        if (decision.kind === 'deny') return decision;
        if (decision.kind === 'ask') pending = decision;
      }
      return pending;
    },
  };
}
