# @kuralle-agents/widget

Embeddable chat widget that adds a `<kuralle-widget>` Web Component to any web page.

## Install

Include the built embed script on your page:

```html
<script src="/path/to/widget.js"></script>
```

Or install for programmatic use:

```bash
npm install @kuralle-agents/widget
```

## What it does

Registers a `<kuralle-widget>` custom element backed by a Preact component. The widget resolves agent configuration from an HTTP endpoint, opens a WebSocket connection to the agent, and renders a floating chat UI with streaming, message queuing, and auto-reconnect.

- **`<kuralle-widget>`** — HTML custom element. Accepts HTML attributes for agent endpoint, theme, position, and colors.
- **`WidgetClient`** — programmatic client class. Fetches agent config from `GET /api/agent/:agentId`, connects via WebSocket, and exposes callback-based APIs for messages, streaming state, connection state, and suggestions.
- **`AgentConfig`** / **`Message`** — types for the resolved agent configuration and chat messages.

## Usage

### HTML embed

```html
<kuralle-widget
  agent-url="https://your-api.example.com"
  agent-id="support"
  position="bottom-right"
  theme="light"
  title="Chat with us"
  subtitle="We're here to help">
</kuralle-widget>
```

The widget calls `GET /api/agent/support` on `agent-url` to resolve the WebSocket URL, then connects directly to the agent.

### Programmatic

```typescript
import { WidgetClient } from '@kuralle-agents/widget';

const client = new WidgetClient('https://your-api.example.com', 'support');
const config = await client.initWidget();

client.onMessages((messages) => console.log(messages));
client.onConnectionChange((connected) => console.log('connected:', connected));

await client.sendMessage('Hello!');

// Cleanup
client.dispose();
```

## Attributes

| Attribute | Description |
|---|---|
| `agent-url` | HTTP base URL for the agent config endpoint (required) |
| `agent-id` | Agent identifier (required) |
| `position` | `bottom-right` (default), `bottom-left`, `top-right`, `top-left` |
| `theme` | `light` (default) or `dark` |
| `title` | Header title |
| `subtitle` | Header subtitle |
| `accent-color` | Primary accent color |
| `base-color` | Base color for theming |
| `button-base-color` | Launcher button base color |
| `button-accent-color` | Launcher button accent color |

## Related

- [`@kuralle-agents/core`](../kuralle-core) — runtime the widget connects to
- [`@kuralle-agents/hono-server`](../kuralle-hono-server) — Hono router that serves the agent WebSocket endpoint
