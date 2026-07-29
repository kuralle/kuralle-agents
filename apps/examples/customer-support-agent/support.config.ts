import { defineSupportConfig } from './src/config';

/**
 * CUSTOMER-OWNED FILE
 *
 * Replace this fictional Northstar data with your brand, policies, and help
 * articles. Agent logic, runtime wiring, identity, durability, and deployment
 * files should not need to change for ordinary customers.
 */
export const supportConfig = defineSupportConfig({
  brand: {
    companyName: 'Northstar',
    agentName: 'Nova',
    productName: 'Northstar Cloud',
    tagline: 'Clear answers, grounded in the policies your team actually operates.',
    accent: '#3157d5',
  },
  behavior: {
    voice: 'Warm, direct, calm, and concise. Use plain language. Acknowledge frustration without becoming theatrical or overly apologetic.',
    scope: 'Help with product questions, account access, subscriptions, invoices, order status, troubleshooting, and human handoff. Never invent account state, prices, policy exceptions, refunds, credits, delivery dates, or completed actions.',
    unavailableMessage: 'I do not have enough verified information to answer that safely. I can help narrow it down or bring in a support specialist.',
  },
  humanSupport: {
    hours: 'Monday–Friday, 09:00–17:00',
    timezone: 'America/New_York',
    estimatedWaitMinutes: 10,
  },
  orderIdPattern: '^NS-[0-9]{6}$',
  starterPrompts: [
    'Where can I find my latest invoice?',
    'What is included in the Pro plan?',
    'Check order NS-100042 for me.',
    'I need to speak with a person.',
  ],
  knowledge: [
    {
      id: 'plans-and-billing',
      title: 'Plans and billing',
      url: 'https://docs.example.com/billing/plans',
      lastModified: '2026-07-01',
      tags: ['billing', 'plans', 'invoice'],
      body: `Northstar Cloud offers Starter, Pro, and Business plans. Starter is intended for individuals. Pro adds team workspaces, audit history, and priority email support. Business adds SSO, custom retention, and a named account team.

Invoices are available to workspace owners under Settings → Billing → Invoices. Monthly plans renew on the same calendar day each month. Annual plans renew on their purchase anniversary. The support agent must not quote a price unless it appears in an authoritative billing-system tool result because regional pricing and contracts vary.`,
    },
    {
      id: 'cancellations-and-refunds',
      title: 'Cancellations and refunds',
      url: 'https://docs.example.com/billing/cancellations',
      lastModified: '2026-07-12',
      tags: ['billing', 'cancel', 'refund'],
      body: `Workspace owners can cancel under Settings → Billing → Manage plan. Cancellation stops the next renewal; access continues through the paid term.

Refund eligibility depends on region, contract, purchase channel, and account history. Never promise or issue a refund from policy text alone. Create a review case only after the customer confirms the summary, then let a billing specialist decide.`,
    },
    {
      id: 'account-recovery',
      title: 'Account access and recovery',
      url: 'https://docs.example.com/account/recovery',
      lastModified: '2026-06-20',
      tags: ['account', 'login', 'security'],
      body: `Customers can request a sign-in link from the login page. Links expire after 15 minutes and can be used once. Ask the customer to check spam and confirm they are using the address tied to the workspace.

Never ask for a password, recovery code, full payment-card number, API token, or identity document in chat. Ownership changes, locked SSO accounts, and suspected account takeover require human support.`,
    },
    {
      id: 'service-incidents',
      title: 'Troubleshooting and incidents',
      url: 'https://docs.example.com/troubleshooting/first-steps',
      lastModified: '2026-07-18',
      tags: ['incident', 'troubleshooting', 'status'],
      body: `For a product issue, first collect the affected feature, approximate start time, expected behavior, actual behavior, and a safe-to-share error code. Ask for one detail at a time. Do not request secrets or raw production data.

Check the public status page before describing a broad outage. If verified status is unavailable, say that clearly. Security incidents, repeated data loss, and issues blocking all users should be escalated immediately.`,
    },
    {
      id: 'shipping-and-orders',
      title: 'Physical orders and shipping',
      url: 'https://docs.example.com/orders/shipping',
      lastModified: '2026-07-08',
      tags: ['orders', 'shipping', 'delivery'],
      body: `Order identifiers use the form NS- followed by six digits. Order status and delivery estimates must come from the order-system tool, not from conversation history or policy text.

An order marked processing has not shipped. An order marked shipped may include a carrier and tracking link. Address changes after shipment and missing deliveries require a human support case. Do not reveal order details unless the authenticated customer owns the order.`,
    },
  ],
});
