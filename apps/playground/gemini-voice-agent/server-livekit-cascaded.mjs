/**
 * Street Burger Sri Lanka — Voice ordering agent (Cascaded pipeline).
 *
 * Uses Google Cloud STT + Sinhala TTS + Kuralle Runtime via LiveKit AgentSession.
 * Bypasses the LiveKit inference gateway — direct provider API connections.
 *
 * Pipeline:
 *   Browser mic → WebSocket → WebSocketTransportAdapter
 *     → Google Cloud STT (gRPC v2, supports Sinhala)
 *     → KuralleRuntimeLLMAdapter (Kuralle Runtime + Gemini Flash)
 *     → Sinhala TTS (OpenAI-compatible endpoint, 24kHz PCM)
 *     → WebSocket binary audio
 *
 * Requires: GOOGLE_APPLICATION_CREDENTIALS or keyFilename, GOOGLE_CLOUD_PROJECT
 *           GOOGLE_GENERATIVE_AI_API_KEY
 */

import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { initializeLogger, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { GoogleSTT } from './google-stt.mjs';
import { google } from '@ai-sdk/google';
import { tool } from 'ai';
import { z } from 'zod';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { KuralleRuntimeLLMAdapter } from '@kuralle-agents/livekit-plugin';
import { WebSocketTransportAdapter } from '@kuralle-agents/livekit-plugin-transport-ws';

initializeLogger({ pretty: true, level: 'info' });

const PORT = process.env.PORT || 3000;

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_CLOUD_SPEECH_KEYFILE && !process.env.GCP_CREDENTIALS_JSON) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS or GCP_CREDENTIALS_JSON for Google Cloud STT');
  process.exit(1);
}
if (!process.env.GOOGLE_CLOUD_PROJECT) {
  console.error('Set GOOGLE_CLOUD_PROJECT for Google Cloud STT recognizer');
  process.exit(1);
}
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.error('Set GOOGLE_GENERATIVE_AI_API_KEY for LLM');
  process.exit(1);
}

// ─── Menu Database ───────────────────────────────────────────────────────────

const MENU = {
  burgers: [
    { id: '1.0-beef', name: '1.0 Beef', price: 1900, category: 'Beef', desc: 'Our signature — char-grilled beef patty, cheddar, sriracha sauce, iceberg lettuce, street mayo' },
    { id: '1.0-crispy', name: '1.0 Crispy', price: 1900, category: 'Chicken', desc: 'Signature crispy fried chicken breast, cheddar, sriracha sauce, iceberg lettuce, street mayo' },
    { id: 'bbq-piston-beef', name: 'BBQ Piston Beef', price: 1900, category: 'Beef', desc: 'Char-grilled beef patty, cheddar, crispy onion rings, smoky BBQ sauce' },
    { id: 'bbq-piston-crispy', name: 'BBQ Piston Crispy', price: 1900, category: 'Chicken', desc: 'Crispy fried chicken, cheddar, crispy onion rings, smoky BBQ sauce' },
    { id: 'hot-silencer', name: 'Hot Silencer Crispy', price: 1900, category: 'Chicken', desc: 'Crispy fried chicken, cheddar, ghost pepper sauce — for spice lovers' },
    { id: 'nitrous-crispy', name: 'Nitrous Crispy', price: 1850, category: 'Chicken', desc: 'Crispy chicken, mozzarella, jalapeños, nitrous hot sauce' },
    { id: 'nitrous-chicken', name: 'Nitrous Chicken', price: 1650, category: 'Chicken', desc: 'Grilled chicken, mozzarella, jalapeños, nitrous hot sauce' },
    { id: 'high-voltage-crispy', name: 'High Voltage Crispy', price: 1900, category: 'Chicken', desc: 'Crispy chicken, double cheddar, sriracha mayo, pickles' },
    { id: 'clutch-beef', name: 'Clutch Beef', price: 1550, category: 'Beef', desc: 'Classic beef patty, American cheese, lettuce, tomato, house sauce' },
    { id: 'clutch-chicken', name: 'Clutch Chicken', price: 1550, category: 'Chicken', desc: 'Grilled chicken breast, American cheese, lettuce, tomato, house sauce' },
    { id: 'drifter-beef', name: 'Drifter Beef', price: 1850, category: 'Beef', desc: 'Beef patty, Swiss cheese, caramelized onions, Dijon mustard' },
    { id: 'drifter-crispy', name: 'Drifter Crispy', price: 1850, category: 'Chicken', desc: 'Crispy chicken, Swiss cheese, caramelized onions, Dijon mustard' },
    { id: 'cheese-up-beef', name: 'Cheese Up Beef', price: 1850, category: 'Beef', desc: 'Triple cheese melt — cheddar, mozzarella, American, beef patty' },
    { id: 'cheese-up-crispy', name: 'Cheese Up Crispy', price: 1850, category: 'Chicken', desc: 'Triple cheese melt — cheddar, mozzarella, American, crispy chicken' },
    { id: 'radiator-beef', name: 'Radiator Beef', price: 1850, category: 'Beef', desc: 'Beef patty, BBQ-glazed grilled chicken bacon, cheddar, ranch' },
    { id: 'radiator-crispy', name: 'Radiator Crispy', price: 1850, category: 'Chicken', desc: 'Crispy chicken, BBQ-glazed grilled chicken bacon, cheddar, ranch' },
    { id: 'fire-bolt', name: 'Fire Bolt Chicken', price: 1650, category: 'Chicken', desc: 'Grilled chicken, habanero sauce, pepper jack cheese, coleslaw' },
    { id: 'twin-drifter', name: 'Twin Drifter Beef', price: 2450, category: 'Beef', desc: 'Double beef patty, double cheddar, pickles, Dijon mustard, caramelized onions' },
    { id: 'f1-beef', name: 'F1 Beef', price: 2250, category: 'Premium', desc: 'Premium wagyu-style beef patty, truffle mayo, aged cheddar, rocket' },
    { id: 'f1-crispy', name: 'F1 Crispy', price: 2000, category: 'Premium', desc: 'Premium crispy chicken, truffle mayo, aged cheddar, rocket' },
    { id: 'hybrid', name: 'Hybrid', price: 2450, category: 'Premium', desc: 'Beef patty AND crispy chicken, chicken bacon, double cheese, special sauce. Our most popular item.' },
  ],
  sides: [
    { id: 'fries', name: 'Fries', price: 950, category: 'Sides', desc: 'Golden crispy fries' },
    { id: 'ripple-stripes', name: 'Ripple Stripes', price: 990, category: 'Sides', desc: 'Crinkle-cut potato stripes' },
    { id: 'loaded-fries', name: 'Loaded Chicken Fries', price: 1550, category: 'Sides', desc: 'Fries topped with crispy chicken, cheese sauce, jalapeños' },
    { id: 'hot-rod', name: 'Hot Rod', price: 1600, category: 'Sides', desc: 'Spicy loaded fries with sriracha mayo and crispy chicken' },
    { id: 'onion-rings', name: 'Onion Rings', price: 650, category: 'Sides', desc: 'Crispy battered onion rings (2 pcs)' },
  ],
  drinks: [
    { id: 'choc-shake', name: 'Chocolate Shake', price: 990, category: 'Shakes', desc: 'Rich creamy chocolate milkshake' },
    { id: 'strawberry-shake', name: 'Strawberry Shake', price: 990, category: 'Shakes', desc: 'Fresh strawberry milkshake' },
    { id: 'vanilla-shake', name: 'Vanilla Shake', price: 990, category: 'Shakes', desc: 'Classic vanilla milkshake' },
    { id: 'blueberry-choc-shake', name: 'Blueberry Chocolate Shake', price: 1350, category: 'Shakes', desc: 'Blueberry and chocolate swirl shake' },
    { id: 'caramel-choc-shake', name: 'Caramel Chocolate Shake', price: 1350, category: 'Shakes', desc: 'Caramel chocolate fusion shake' },
    { id: 'mango-shake', name: 'Mango Vanilla Shake', price: 1350, category: 'Shakes', desc: 'Tropical mango vanilla shake' },
    { id: 'peach-shake', name: 'Peach Vanilla Shake', price: 1350, category: 'Shakes', desc: 'Sweet peach vanilla shake' },
    { id: 'blue-cura-mojito', name: 'Blue Curacao Mojito', price: 850, category: 'Mocktails', desc: 'Refreshing blue curacao mocktail' },
    { id: 'mango-mojito', name: 'Mango Mojito', price: 850, category: 'Mocktails', desc: 'Tropical mango mojito' },
    { id: 'strawberry-mojito', name: 'Strawberry Mojito', price: 850, category: 'Mocktails', desc: 'Fresh strawberry mojito' },
    { id: 'pepsi', name: 'Pepsi', price: 320, category: 'Soft Drinks', desc: 'Chilled Pepsi can' },
    { id: '7up', name: '7Up', price: 320, category: 'Soft Drinks', desc: 'Chilled 7Up can' },
    { id: 'milo', name: 'Ice Milo', price: 990, category: 'Soft Drinks', desc: 'Classic Sri Lankan iced Milo' },
    { id: 'water', name: 'Water Bottle', price: 70, category: 'Soft Drinks', desc: '500ml bottled water' },
  ],
};

const ALL_ITEMS = [...MENU.burgers, ...MENU.sides, ...MENU.drinks];

const LOCATIONS = [
  'Bambalapitiya', 'Ethul Kotte', 'Nawala', 'Mount Lavinia',
  'Wattala', 'Maharagama', 'Galle',
];
const HOTLINE = '0112 548 548';
const HOURS = 'Open daily 11 AM to midnight. Fridays closed 12:00 PM to 1:30 PM for prayers.';

// ─── In-Memory Order Database ────────────────────────────────────────────────

const orderDB = new Map();
const sessionCarts = new Map();

function getCart(sessionId) {
  if (!sessionCarts.has(sessionId)) {
    sessionCarts.set(sessionId, { items: [], customerName: '', phone: '', location: '' });
  }
  return sessionCarts.get(sessionId);
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const browseMenu = tool({
  description: 'Search the Street Burger menu. Filter by category, name, or max price. Returns matching items with IDs, names, prices, and descriptions.',
  inputSchema: z.object({
    category: z.string().optional().describe('Category: Beef, Chicken, Premium, Sides, Shakes, Mocktails, Soft Drinks'),
    search: z.string().optional().describe('Search by item name or keyword'),
    maxPrice: z.number().optional().describe('Maximum price in LKR'),
  }),
  execute: async ({ category, search, maxPrice }) => {
    let results = ALL_ITEMS;
    if (category) {
      const cat = category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
      results = results.filter(i => i.category === cat);
    }
    if (search) {
      const q = search.toLowerCase();
      results = results.filter(i => i.name.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q));
    }
    if (maxPrice) {
      results = results.filter(i => i.price <= maxPrice);
    }
    return {
      found: results.length,
      items: results.slice(0, 12).map(i => ({ id: i.id, name: i.name, price: i.price, category: i.category, desc: i.desc })),
    };
  },
});

const getLocations = tool({
  description: 'List all Street Burger branch locations',
  inputSchema: z.object({}),
  execute: async () => ({ total: LOCATIONS.length, locations: LOCATIONS, hotline: HOTLINE }),
});

const getHours = tool({
  description: 'Get business hours and contact info',
  inputSchema: z.object({}),
  execute: async () => ({ hours: HOURS, hotline: HOTLINE }),
});

const addToCart = tool({
  description: 'Add an item to the customer\'s cart. Use the item ID from browseMenu results.',
  inputSchema: z.object({
    itemId: z.string().describe('Item ID from menu (e.g. "1.0-beef", "fries", "choc-shake")'),
    quantity: z.number().default(1).describe('Quantity'),
  }),
  execute: async ({ itemId, quantity }) => {
    const item = ALL_ITEMS.find(i => i.id === itemId);
    if (!item) return { error: `Item "${itemId}" not found. Use browseMenu to find item IDs.` };
    const cart = getCart('default');
    const existing = cart.items.find(i => i.itemId === itemId);
    if (existing) {
      existing.quantity += quantity;
    } else {
      cart.items.push({ itemId: item.id, name: item.name, price: item.price, quantity });
    }
    const total = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    return {
      added: { name: item.name, price: item.price, quantity },
      cart: { items: cart.items.map(i => `${i.name} x${i.quantity} — LKR ${(i.price * i.quantity).toLocaleString()}`), total: `LKR ${total.toLocaleString()}` },
    };
  },
});

const viewCart = tool({
  description: 'Show the current cart contents and total',
  inputSchema: z.object({}),
  execute: async () => {
    const cart = getCart('default');
    if (cart.items.length === 0) return { empty: true, message: 'Your cart is empty.' };
    const total = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    return {
      items: cart.items.map(i => ({ name: i.name, qty: i.quantity, unitPrice: i.price, subtotal: i.price * i.quantity })),
      total,
      totalFormatted: `LKR ${total.toLocaleString()}`,
    };
  },
});

const clearCart = tool({
  description: 'Clear all items from the cart',
  inputSchema: z.object({}),
  execute: async () => {
    sessionCarts.delete('default');
    return { cleared: true };
  },
});

const placeOrder = tool({
  description: 'Place the order. Requires customer name, phone, and pickup location. Confirm all details with the customer first.',
  inputSchema: z.object({
    customerName: z.string().describe('Customer full name'),
    phone: z.string().describe('Customer phone number'),
    location: z.string().describe('Pickup location branch name'),
    notes: z.string().optional().describe('Special instructions'),
  }),
  execute: async ({ customerName, phone, location, notes }) => {
    const cart = getCart('default');
    if (cart.items.length === 0) return { error: 'Cart is empty. Add items before placing an order.' };
    if (!LOCATIONS.some(l => l.toLowerCase() === location.toLowerCase())) {
      return { error: `Unknown location "${location}". Available: ${LOCATIONS.join(', ')}` };
    }
    const orderId = `SB-${Date.now().toString(36).toUpperCase()}`;
    const total = cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const order = {
      orderId, status: 'confirmed', customerName, phone, location, notes: notes || '',
      items: cart.items.map(i => ({ name: i.name, qty: i.quantity, subtotal: i.price * i.quantity })),
      total, estimatedReady: '20-25 minutes', createdAt: new Date().toISOString(),
    };
    orderDB.set(orderId, order);
    sessionCarts.delete('default');
    return order;
  },
});

// ─── Kuralle Runtime (text, not realtime) ────────────────────────────────────

const runtime = createRuntime({
  agents: [{
    id: 'streetburger',
    name: 'Street Burger Ordering Agent',
    model: google('gemini-3.1-flash-lite-preview'),
    instructions: `You are the voice ordering assistant for Street Burger, Sri Lanka's gourmet burger restaurant.

CRITICAL LANGUAGE RULE — ZERO ENGLISH:
You MUST reply ONLY in pure native Sri Lankan Sinhala. ABSOLUTELY NO English words are allowed in your output — not a single one.
- Translate EVERY proper noun, brand name, and menu item into Sinhala script (සිංහල අක්ෂර).
- "Hybrid" → "හයිබ්‍රිඩ්", "Hot Silencer" → "හොට් සයිලන්සර්", "burger" → "බර්ගර්", "beef" → "බීෆ්", "chicken" → "චිකන්", "cheese" → "චීස්", "combo" → "කොම්බෝ", "menu" → "මෙනූව", "cart" → "කරත්තය", "order" → "ඇණවුම", "rupees" → "රුපියල්", "Street Burger" → "ස්ට්‍රීට් බර්ගර්", "Sri Lanka" → "ශ්‍රී ලංකාව".
- Even numbers and prices must be written in Sinhala words or Sinhala numerals: "රුපියල් 950" not "Rs. 950".
- The customer may speak English, Sinhala, or both — but YOUR response must be 100% Sinhala. If you output even one English word, the response is WRONG.

Be warm, clear, and professional — like a well-trained host at a good restaurant.
Speak naturally. No slang, no forced enthusiasm, no exclamation marks.
All prices are in Sri Lankan Rupees (LKR). You have 7 branches: ${LOCATIONS.join(', ')}.
Hotline: ${HOTLINE}. Hours: ${HOURS}

You MUST use tools for all menu lookups, cart operations, and order placement. Never make up prices or items.

ORDERING STAGES — follow this sequence naturally:

1. GREETING: Welcome the caller briefly in Sinhala. Ask how you can help — menu, locations, or placing an order.

2. BROWSING: When the customer wants to explore or order, help them find items using browseMenu.
   - Ask what they're in the mood for and suggest items — all in Sinhala.
   - The Hybrid (හයිබ්‍රිඩ්) is our most popular item. Hot Silencer (හොට් සයිලන්සර්) is the spicy favourite.
   - When they pick something, add it with addToCart. Suggest sides or a drink to go with it.

3. CHECKOUT: When they say they're done, move to checkout.
   - Use viewCart to show the full order and total.
   - You need: customer name, phone number, and pickup location.
   - Confirm all details back to the customer before calling placeOrder.
   - After placing, give them the order ID and estimated pickup time (20-25 minutes).

RULES:
- Keep responses to 1-2 sentences.
- ALWAYS speak in Sinhala. Even when reading tool results back, translate everything to Sinhala.
- If they want to change or remove items, use clearCart and rebuild.
- If they ask about hours or locations, answer using the tools — in Sinhala.
- Never skip checkout — always confirm details before placing an order.`,
    tools: { browseMenu, addToCart, viewCart, clearCart, getLocations, getHours, placeOrder },
  }],
  defaultAgentId: 'streetburger',
  defaultModel: google('gemini-2.5-flash-preview-05-20'),
  voiceMode: true,
});

// ─── Pre-warm Sinhala TTS endpoint (cold-start Modal container) ──────────────
const SINHALA_TTS_URL = 'https://asyncdotengineering--sinhala-tts-alpha-alphatts-serve.modal.run/v1';
fetch(`${SINHALA_TTS_URL}/models`, { method: 'GET' }).then(
  () => console.log('Sinhala TTS pre-warm ping sent'),
  () => console.log('Sinhala TTS pre-warm ping failed (non-fatal)'),
);

// ─── HTTP + WebSocket server ─────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(new URL('./client.html', import.meta.url)));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok', agent: 'streetburger',
    pipeline: 'google-stt → kuralle-runtime → sinhala-tts',
    menuItems: ALL_ITEMS.length, ordersPlaced: orderDB.size, uptime: process.uptime(),
  }));
});

const wss = new WebSocketServer({ server: httpServer });

function sendJson(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* closed */ }
}

wss.on('connection', async (ws) => {
  const sessionId = `sb-${Date.now()}`;
  console.log(`[${sessionId}] WS connected (cascaded pipeline)`);

  const adapter = new WebSocketTransportAdapter(ws, {
    id: sessionId,
    sampleRate: 24000,
    numChannels: 1,
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'end_of_audio') adapter.audioInput.endOfAudio();
      else if (msg.type === 'end_session') ws.close(1000, 'client end_session');
    } catch { /* non-protocol text */ }
  });

  const ariaLLM = new KuralleRuntimeLLMAdapter({
    runtime,
    sessionId,
    onKuralleHandoff: (from, to) => {
      console.log(`[${sessionId}] handoff: ${from} → ${to}`);
      sendJson(ws, { type: 'handoff', from, to });
    },
  });

  const agent = new voice.Agent({
    instructions: 'You MUST speak only in Sinhala. Never reply in English — always respond in native Sri Lankan Sinhala.',
  });

  const stt = new GoogleSTT({
    languages: ['si-LK', 'en-US'],
    detectLanguage: true,
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    keyFilename: process.env.GOOGLE_CLOUD_SPEECH_KEYFILE || process.env.GOOGLE_APPLICATION_CREDENTIALS,
    model: 'latest_long',
    sampleRate: 24000,
  });
  const tts = new openai.TTS({
    baseURL: 'https://asyncdotengineering--sinhala-tts-alpha-alphatts-serve.modal.run/v1',
    apiKey: 'ignored',
    model: 'tts-1',
    voice: 'alloy',
  });

  const session = new voice.AgentSession({
    stt,
    llm: ariaLLM,
    tts,
    maxToolSteps: 5,
  });

  session.input.audio = adapter.audioInput;
  session.output.audio = adapter.audioOutput;
  session.output.transcription = adapter.textOutput;

  let ended = false;
  const closeSession = (reason) => {
    if (ended) return;
    ended = true;
    console.log(`[${sessionId}] ended: ${reason}`);
    session.close().catch((err) => console.error(`[${sessionId}] close error:`, err));
  };

  ws.once('close', () => closeSession('client_disconnect'));
  ws.once('error', () => closeSession('socket_error'));

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    console.log(`[${sessionId}] agent: ${ev.oldState} → ${ev.newState}`);
    sendJson(ws, { type: 'agent_state', state: ev.newState });
  });

  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (ev.isFinal) console.log(`[${sessionId}] STT: "${ev.transcript}"`);
    sendJson(ws, { type: 'user_transcription', text: ev.transcript, isFinal: ev.isFinal });
  });

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type === 'message' && item.role === 'assistant') {
      const text = item.content
        ?.filter(c => typeof c === 'string' || c?.type === 'text')
        .map(c => typeof c === 'string' ? c : c.text)
        .join('');
      if (text) {
        console.log(`[${sessionId}] agent: "${text.slice(0, 120)}"`);
        sendJson(ws, { type: 'agent_transcript', text });
      }
    }
  });

  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
    for (const call of ev.functionCalls) {
      console.log(`[${sessionId}] tool_call: ${call.name}`);
      sendJson(ws, { type: 'tool_call', name: call.name, args: call.args });
    }
    for (const out of ev.functionCallOutputs) {
      console.log(`[${sessionId}] tool_result: ${out.name} → ${String(out.output).slice(0, 120)}`);
      sendJson(ws, { type: 'tool_result', name: out.name, output: out.output, isError: out.isError });
    }
  });

  session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
    sendJson(ws, { type: 'metrics_collected', metricsType: ev.metrics?.type });
  });

  session.on(voice.AgentSessionEventTypes.Close, (ev) => closeSession(String(ev.reason)));
  session.on(voice.AgentSessionEventTypes.Error, (ev) => {
    console.error(`[${sessionId}] error:`, ev.error);
    sendJson(ws, {
      type: 'error',
      message: ev.error instanceof Error ? ev.error.message : String(ev.error),
    });
  });

  try {
    await session.start({ agent });
    sendJson(ws, {
      type: 'session_started',
      sessionId,
      config: { sampleRate: 24000, numChannels: 1, encoding: 'pcm_s16le' },
    });
    console.log(`[${sessionId}] Street Burger cascaded session started (Google STT → KuralleRuntime → Sinhala TTS)`);
  } catch (err) {
    console.error(`[${sessionId}] start failed:`, err);
    try { await session.close(); } catch { /* swallow */ }
    try { ws.close(4000, 'Failed'); } catch { /* swallow */ }
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Street Burger Voice Agent (Cascaded) — http://localhost:${PORT}`);
  console.log(`  Pipeline: Google Cloud STT (Sinhala) → KuralleRuntimeLLMAdapter → Sinhala TTS (24kHz PCM)`);
  console.log(`  ${ALL_ITEMS.length} menu items | ${LOCATIONS.length} branches`);
  console.log(`  Open http://localhost:${PORT} in Chrome for the ordering client\n`);
});
