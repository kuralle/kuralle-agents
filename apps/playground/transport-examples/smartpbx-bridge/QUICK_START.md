# SmartPBX Bridge - Quick Start Guide

## 5-Minute Setup

### 1. Install Dependencies

```bash
cd apps/playground/transport-examples/smartpbx-bridge
bun install
```

### 2. Configure SmartPBX

Configure your SmartPBX trunk with these settings:

**Audio Configuration (IMPORTANT for best performance):**
```
Encoding: PCM16
Sample Rate: 24000 Hz
```

**WebSocket URL:**
```
wss://your-domain.com/media-stream
```

**Webhook URL:**
```
http://your-domain.com/
```

### 3. Start the Server

```bash
bun run start
```

### 4. Test the Connection

```bash
curl http://localhost:8080/health
```

You should see:
```json
{
  "status": "OK",
  "supported_formats": [
    "PCM16 @ 24kHz (passthrough - optimal)",
    "PCM16 @ 8kHz (resample)",
    "G.711 μ-law @ 8kHz (convert)",
    "Opus (decode/encode)"
  ]
}
```

### 5. Make a Test Call

1. Call your SmartPBX number
2. You should hear: "Hello! Thank you for calling customer support. How can I help you today?"
3. Try: "Can you check order ORD-12345?"
4. Agent responds with order information

## Common Issues

### Audio not working

**Check the format detection:**
```
Look for log messages like:
✅ PASSTHROUGH MODE: 24kHz PCM16
⚡ RESAMPLE MODE: PCM16 8kHz → 24kHz
🔧 G.711 μ-law MODE: 8kHz → PCM16 24kHz
```

**Solution:** Configure SmartPBX for 24kHz PCM16

### Opus codec not available

```bash
bun add opusscript
```

Then restart the server.

## Environment Variables

```bash
# Optional: Override defaults
PORT=8080
HOST=0.0.0.0
```

## Production Deployment

### Railway

```bash
railway init
railway up
```

### Render

```bash
# Install render CLI
npm install -g render-cli

# Deploy
render deploy
```

### Docker

```bash
docker build -t smartpbx-bridge .
docker run -p 8080:8080 smartpbx-bridge
```

## Testing Without SmartPBX

You can test the WebSocket with a simple client:

```javascript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080/media-stream');

ws.on('open', () => {
  console.log('Connected!');
  
  // Send start event
  ws.send(JSON.stringify({
    event: 'start',
    start: {
      callId: 'test-call-123',
      accountId: 'test-account',
      mediaFormat: {
        encoding: 'pcm16',
        sampleRate: '24000'
      }
    }
  }));
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
});
```

## Support

For issues or questions:
- Check the main README.md for detailed documentation
- Review the logs for error messages
- Ensure all dependencies are installed: `bun install`
