import { Hono } from 'hono';

export const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));

// Bun binds this automatically when the file is run directly; importing `app` does not.
export default app;
