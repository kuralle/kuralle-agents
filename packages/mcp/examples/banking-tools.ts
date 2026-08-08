import { z } from 'zod';

import type { ExampleTool } from './_server.js';

/** Synthetic Meridian Bank accounts — invented names and numbers only. */
const ACCOUNTS: Record<string, { holder: string; balance: number; type: string }> = {
  'chk-001': { holder: 'Avery Finch', balance: 4_820.5, type: 'checking' },
  'sav-001': { holder: 'Avery Finch', balance: 12_400, type: 'savings' },
  'chk-002': { holder: 'Jordan Vale', balance: 910.25, type: 'checking' },
};

const TRANSACTIONS: Record<string, Array<{ id: string; date: string; description: string; amount: number }>> = {
  'chk-001': [
    { id: 'txn-1001', date: '2026-07-01', description: 'Meridian Market — groceries', amount: -42.17 },
    { id: 'txn-1002', date: '2026-07-03', description: 'Direct deposit — Vale Consulting', amount: 2_800 },
    { id: 'txn-1003', date: '2026-07-05', description: 'Transfer to savings', amount: -500 },
  ],
  'sav-001': [
    { id: 'txn-2001', date: '2026-07-05', description: 'Transfer from checking', amount: 500 },
    { id: 'txn-2002', date: '2026-06-15', description: 'Interest credit', amount: 18.42 },
  ],
  'chk-002': [
    { id: 'txn-3001', date: '2026-07-02', description: 'Harbor Cafe', amount: -14.5 },
  ],
};

const PAYEES: Array<{ id: string; name: string; accountHint: string }> = [
  { id: 'payee-1', name: 'Northwind Utilities', accountHint: '****4821' },
  { id: 'payee-2', name: 'Cedar Lane Rent Co-op', accountHint: '****9033' },
  { id: 'payee-3', name: 'Meridian Mutual Insurance', accountHint: '****7710' },
];

const PENDING_TRANSFERS: Record<string, { from: string; to: string; amount: number; status: string }> = {
  'xfer-9001': { from: 'chk-001', to: 'payee-1', amount: 125, status: 'pending' },
};

export function bankingTools(): ExampleTool[] {
  return [
    {
      name: 'get_balance',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Return the current balance for a Meridian Bank account. Use account ids like chk-001 or sav-001.',
      inputSchema: z.object({
        account: z.string().describe('Meridian Bank account id, e.g. chk-001'),
      }),
      handler: (args) => {
        const account = String(args.account ?? '');
        const row = ACCOUNTS[account];
        if (!row) {
          throw new Error(`Unknown Meridian Bank account: ${account}`);
        }
        return {
          institution: 'Meridian Bank',
          account,
          holder: row.holder,
          type: row.type,
          balance: row.balance,
          currency: 'USD',
        };
      },
    },
    {
      name: 'list_transactions',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'List recent ledger entries for a Meridian Bank account. Returns newest entries first.',
      inputSchema: z.object({
        account: z.string().describe('Meridian Bank account id'),
        limit: z.number().int().positive().max(50).optional().describe('Max rows to return'),
      }),
      handler: (args) => {
        const account = String(args.account ?? '');
        const limit = typeof args.limit === 'number' ? args.limit : 10;
        const rows = TRANSACTIONS[account];
        if (!rows) {
          throw new Error(`Unknown Meridian Bank account: ${account}`);
        }
        return {
          institution: 'Meridian Bank',
          account,
          transactions: rows.slice(0, limit),
        };
      },
    },
    {
      name: 'find_payee',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Search saved payees at Meridian Bank by partial name. Returns matching payee ids for transfers.',
      inputSchema: z.object({
        query: z.string().describe('Substring to match against payee name'),
      }),
      handler: (args) => {
        const query = String(args.query ?? '').toLowerCase();
        const matches = PAYEES.filter((p) => p.name.toLowerCase().includes(query));
        return {
          institution: 'Meridian Bank',
          payees: matches,
        };
      },
    },
    {
      name: 'transfer_funds',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      description:
        'Move money between Meridian Bank accounts or to a saved payee. Destructive — debits the source immediately.',
      inputSchema: z.object({
        from: z.string().describe('Source Meridian Bank account id'),
        to: z.string().describe('Destination account id or saved payee id'),
        amount: z.number().positive().describe('Amount in USD to transfer'),
        memo: z.string().optional().describe('Optional transfer note'),
      }),
      handler: (args) => {
        const from = String(args.from ?? '');
        const to = String(args.to ?? '');
        const amount = Number(args.amount);
        const source = ACCOUNTS[from];
        if (!source) {
          throw new Error(`Unknown source account: ${from}`);
        }
        if (amount > source.balance) {
          throw new Error(`Insufficient funds on ${from}`);
        }
        const payee = PAYEES.find((p) => p.id === to);
        return {
          institution: 'Meridian Bank',
          transferId: 'xfer-9100',
          from,
          to,
          payeeName: payee?.name,
          amount,
          status: 'completed',
          memo: args.memo ? String(args.memo) : undefined,
        };
      },
    },
    {
      name: 'cancel_transfer',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        'Cancel a pending Meridian Bank transfer before it settles. Only pending transfers can be cancelled.',
      inputSchema: z.object({
        transferId: z.string().describe('Transfer id returned by transfer_funds or list operations'),
      }),
      handler: (args) => {
        const transferId = String(args.transferId ?? '');
        const pending = PENDING_TRANSFERS[transferId];
        if (!pending) {
          throw new Error(`No pending transfer with id ${transferId}`);
        }
        return {
          institution: 'Meridian Bank',
          transferId,
          status: 'cancelled',
          previous: pending,
        };
      },
    },
  ];
}
