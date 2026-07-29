export const KNOWLEDGE_DOCUMENTS = [
  {
    id: 'kuralle-runtime',
    title: 'Kuralle runtime boundary',
    category: 'runtime',
    content: 'Kuralle separates durable orchestration from the channel driver. Sessions, approvals, tools, traces, routing, and replay belong to the runtime; Pi or Core\'s built-in AI SDK loop can drive the same agent definition.',
  },
  {
    id: 'durable-approvals',
    title: 'Durable approvals',
    category: 'safety',
    content: 'A consequential tool can declare needsApproval. Kuralle freezes the exact operation, pauses the run, records a request-bound signal, and executes it only after an authenticated actor approves. Replays reuse the recorded effect instead of repeating it.',
  },
  {
    id: 'postgres-memory',
    title: 'Hybrid memory in Postgres',
    category: 'memory',
    content: 'Semantic vectors and generated tsvector columns complement each other. Reciprocal Rank Fusion combines vector and full-text ranks without assuming their scores share a scale. Every branch must filter by the server-authenticated user id.',
  },
  {
    id: 'retrieval-first',
    title: 'Retrieval-first answering',
    category: 'rag',
    content: 'Production assistants should retrieve before answering domain facts. Kuralle can inject knowledge automatically before every answering turn, cache similar queries within a session, and attach source metadata to retrieved chunks.',
  },
  {
    id: 'session-identity',
    title: 'Session identity isolation',
    category: 'security',
    content: 'Never trust a browser-supplied user id or raw session id. Resolve identity from an authenticated server cookie and namespace the durable conversation id by that identity before calling the runtime.',
  },
  {
    id: 'tool-contracts',
    title: 'Tool contracts',
    category: 'tools',
    content: 'Tools are authority boundaries, not prompt suggestions. Inputs need strict schemas, reads must be scoped, writes should be transactional and approval-gated, and the assistant must never claim success without a successful result.',
  },
] as const;

export const DEMO_ORDERS = [
  { orderId: 'order_1001', items: ['Kuralle Field Guide', 'Trace Notebook'], total: '49.99', status: 'delivered' },
  { orderId: 'order_1002', items: ['Approval Console Keycap'], total: '29.99', status: 'pending' },
] as const;
