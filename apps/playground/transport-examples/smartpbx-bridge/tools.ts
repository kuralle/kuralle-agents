/**
 * Customer Support Agent Tools
 * 
 * These tools demonstrate how to integrate business logic
 * into your voice agent through the Kuralle Runtime.
 */
import { tool } from 'ai';
import { z } from 'zod';

// ============================================================================
// Mock Database
// ============================================================================

const ORDERS: Record<string, {
  status: string;
  tracking: string;
  items: Array<{ name: string; quantity: number }>;
  shippedDate: string;
  estimatedDelivery: string;
}> = {
  'ORD-12345': {
    status: 'shipped',
    tracking: '1Z999AA1',
    items: [
      { name: 'Wireless Headphones', quantity: 1 },
      { name: 'USB-C Cable', quantity: 2 },
    ],
    shippedDate: '2024-01-15',
    estimatedDelivery: '2024-01-20',
  },
  'ORD-67890': {
    status: 'processing',
    tracking: '',
    items: [
      { name: 'Mechanical Keyboard', quantity: 1 },
    ],
    shippedDate: '',
    estimatedDelivery: '2024-01-25',
  },
};

const PRODUCTS: Record<string, {
  name: string;
  price: number;
  description: string;
  inStock: boolean;
}> = {
  'premium-plan': {
    name: 'Premium Plan',
    price: 29.99,
    description: '100 GB storage, priority support, advanced analytics, API access',
    inStock: true,
  },
  'basic-plan': {
    name: 'Basic Plan',
    price: 9.99,
    description: '5 GB storage, email support, basic analytics',
    inStock: true,
  },
  'enterprise-plan': {
    name: 'Enterprise Plan',
    price: 99.99,
    description: 'Unlimited storage, 24/7 phone support, custom integrations',
    inStock: true,
  },
};

// ============================================================================
// Tools
// ============================================================================

/**
 * Look up an order by ID
 * 
 * @param orderId - The order ID to look up
 * @returns Order information including status, tracking, and items
 */
async function lookupOrder(orderId: string) {
  console.log(`🔧 TOOL: lookupOrder(${JSON.stringify({ orderId })})`);
  
  // Simulate database lookup delay
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const order = ORDERS[orderId.toUpperCase()];
  
  if (!order) {
    return {
      found: false,
      message: `Order ${orderId} not found. Please check your order ID and try again.`,
    };
  }
  
  return {
    found: true,
    orderId: orderId.toUpperCase(),
    status: order.status,
    tracking: order.tracking,
    trackingUrl: order.tracking ? `https://track.example.com/${order.tracking}` : null,
    items: order.items,
    shippedDate: order.shippedDate,
    estimatedDelivery: order.estimatedDelivery,
    message: `Order ${orderId} is ${order.status}. ${order.tracking ? `Tracking number: ${order.tracking}` : 'Not yet shipped.'}`,
  };
}

/**
 * Get product information
 * 
 * @param productId - The product/plan ID to look up
 * @returns Product information including pricing and availability
 */
async function getProductInfo(productId: string) {
  console.log(`🔧 TOOL: getProductInfo(${JSON.stringify({ productId })})`);
  
  // Simulate database lookup delay
  await new Promise(resolve => setTimeout(resolve, 50));
  
  const product = PRODUCTS[productId.toLowerCase()];
  
  if (!product) {
    return {
      found: false,
      message: `Product ${productId} not found. Available products: premium-plan, basic-plan, enterprise-plan`,
    };
  }
  
  return {
    found: true,
    productId: productId.toLowerCase(),
    name: product.name,
    price: product.price,
    description: product.description,
    inStock: product.inStock,
    message: `${product.name} is $${product.price}/month. ${product.inStock ? 'Currently in stock.' : 'Out of stock.'}`,
  };
}

/**
 * Transfer the call to a human agent
 * 
 * @param reason - The reason for the transfer
 * @returns Transfer confirmation
 */
async function transferToHuman(reason: string) {
  console.log(`🔧 TOOL: transferToHuman(${JSON.stringify({ reason })})`);
  
  // Simulate transfer process
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // In a real implementation, this would:
  // 1. Log the transfer reason
  // 2. Create a ticket in your support system
  // 3. Transfer the call to a human agent queue
  // 4. Provide context to the human agent
  
  return {
    transferred: true,
    agent: 'human-support',
    queuePosition: Math.floor(Math.random() * 5) + 1,
    estimatedWaitTime: `${Math.floor(Math.random() * 3) + 1} minutes`,
    ticketNumber: `TKT-${Date.now()}`,
    message: `I'm transferring you to a human agent. Your ticket number is ${Date.now()}. Estimated wait time is ${Math.floor(Math.random() * 3) + 1} minutes.`,
  };
}

/**
 * Check account balance
 * 
 * @param accountId - The account ID to check
 * @returns Account balance information
 */
async function checkBalance(accountId: string) {
  console.log(`🔧 TOOL: checkBalance(${JSON.stringify({ accountId })})`);
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Mock account balance
  const balance = Math.floor(Math.random() * 1000);
  
  return {
    accountId,
    balance,
    currency: 'USD',
    lastPaymentDate: '2024-01-01',
    nextBillingDate: '2024-02-01',
    message: `Your current balance is $${balance}.00. Your next billing date is February 1st, 2024.`,
  };
}

/**
 * Update account information
 * 
 * @param accountId - The account ID to update
 * @param updates - The fields to update
 * @returns Update confirmation
 */
async function updateAccount(accountId: string, updates: Record<string, unknown>) {
  console.log(`🔧 TOOL: updateAccount(${JSON.stringify({ accountId, updates })})`);
  
  await new Promise(resolve => setTimeout(resolve, 150));
  
  return {
    accountId,
    updated: true,
    fields: Object.keys(updates),
    message: `Account ${accountId} has been updated successfully.`,
  };
}

// ============================================================================
// Export all tools
// ============================================================================

export const tools = {
  lookupOrder: tool({
    description: 'Look up an order by order ID',
    inputSchema: z.object({
      orderId: z.string(),
    }),
    execute: async ({ orderId }) => lookupOrder(orderId),
  }),
  getProductInfo: tool({
    description: 'Get product information by product ID',
    inputSchema: z.object({
      productId: z.string(),
    }),
    execute: async ({ productId }) => getProductInfo(productId),
  }),
  transferToHuman: tool({
    description: 'Transfer caller to a human support queue',
    inputSchema: z.object({
      reason: z.string(),
    }),
    execute: async ({ reason }) => transferToHuman(reason),
  }),
  checkBalance: tool({
    description: 'Check account balance by account ID',
    inputSchema: z.object({
      accountId: z.string(),
    }),
    execute: async ({ accountId }) => checkBalance(accountId),
  }),
  updateAccount: tool({
    description: 'Update account fields for the given account ID',
    inputSchema: z.object({
      accountId: z.string(),
      updates: z.record(z.string(), z.unknown()),
    }),
    execute: async ({ accountId, updates }) => updateAccount(accountId, updates),
  }),
};
