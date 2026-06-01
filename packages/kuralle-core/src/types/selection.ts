/** Author-facing choice option (RFC §4.5). Stable shape. */
export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  url?: string;
  flow?: { flowId: string; cta: string };
}

/** A structured inbound selection propagated into a run (RFC §4.8 / REQ-20). */
export interface ResolvedSelection {
  /** Stable id (button/list id, template button payload) — exposed as the routing `input`. */
  id?: string;
  /** Flow-form submission data (e.g. WhatsApp Flow nfm_reply) merged into flow state at turn start. */
  formData?: Record<string, unknown>;
}
