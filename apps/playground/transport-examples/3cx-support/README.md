# 3CX PBX Integration Example

This example demonstrates how to connect Kuralle voice agents with 3CX PBX using **SIP trunking**.

## How It Works

```
┌──────────────┐      SIP Trunk      ┌─────────────────────────────────┐
│     3CX      │ ◄─────────────────► │  Kuralle SIP Server            │
│     PBX      │   (INVITE + RTP)    │  (SIPAgentServer)              │
└──────────────┘                      └─────────────┬───────────────────┘
                                                     │
                                                     ▼
                                       ┌─────────────────────────────────┐
                                       │   KuralleVoiceSession          │
                                       │   - STT (Speech-to-Text)        │
                                       │   - LLM (GPT-4o-mini)           │
                                       │   - TTS (Text-to-Speech)        │
                                       └─────────────────────────────────┘
```

## Quick Start

### 1. Start the Kuralle Server

```bash
cd apps/playground/transport-examples
bun run 3cx-support
```

### 2. Configure 3CX SIP Trunk

1. Open **3CX Management Console**
2. Go to **Voice & Chat** → **+ Add Trunk**
3. Select **"Generic SIP Trunk (IP Based)"**
4. Configure:
   - **Trunk Name**: `Kuralle AI Agent`
   - **IP Address/Hostname**: Your server IP (e.g., `192.168.1.100`)
   - **Port**: `5060`
   - **Transport**: `UDP`
5. Click **OK** to create the trunk

### 3. Create Inbound Rule

1. Go to **Inbound Rules** → **+ Add**
2. Select the **DID** you want to route (or "Any DID")
3. Set destination to: **SIP Trunk** → **Kuralle AI Agent**
4. Click **OK**

### 4. Test

Call your 3CX DID number. The call should route to the Kuralle agent!

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_IP` | `0.0.0.0` | IP address to bind to |
| `SIP_PORT` | `5060` | SIP port to listen on |
| `RTP_PORT_START` | `10000` | Start of RTP port range |

### Example

```bash
# Bind to specific IP
SERVER_IP=192.168.1.100 bun run 3cx-support

# Use different SIP port
SIP_PORT=6060 bun run 3cx-support
```

## 3CX Setup Details

### SIP Trunk Configuration

| Setting | Value |
|---------|-------|
| **Trunk Type** | Generic SIP Trunk (IP Based) |
| **IP Address** | Your Kuralle server IP |
| **Port** | 5060 (or custom) |
| **Transport** | UDP |
| **Authentication** | Not required (or configure as needed) |

### Codec Support

| Codec | Name | Sample Rate |
|-------|------|-------------|
| **PCMU** | G.711 μ-law | 8kHz |
| PCMA | G.711 A-law | 8kHz |

**Note**: 3CX uses G.711 μ-law (PCMU) by default, which is the standard for telephony.

## Testing Options

### Option 1: Test with 3CX (Recommended)

1. Deploy server to public IP or configure network
2. Configure 3CX SIP trunk
3. Call your 3CX DID
4. Verify agent answers

### Option 2: Test with SIP Softphone

For local testing without 3CX:

```bash
# Start the server
bun run 3cx-support

# Use a SIP softphone (Linphone, Zoiper, etc.)
# Address: 127.0.0.1:5060
# Transport: UDP
# Send INVITE to start call
```

### Option 3: Use ngrok for Remote Testing

```bash
# Install ngrok
brew install ngrok  # macOS

# Start ngrok for UDP
ngrok udp 5060

# Use the ngrok URL in 3CX configuration
# Example: 0.tcp.ngrok.io:12345
```

## Troubleshooting

### Calls Not Reaching Server

1. **Check firewall** - Ensure ports 5060 (UDP) and RTP range (10000-20000) are open
2. **Verify IP** - Use correct IP address in 3CX trunk configuration
3. **Check logs** - Look for incoming INVITE messages in server output

### Audio Issues

1. **Codec mismatch** - Ensure 3CX is using G.711 μ-law (PCMU)
2. **RTP ports** - Verify RTP port range is accessible
3. **NAT issues** - Use STUN/TURN if server is behind NAT

### Debug SIP Messages

```bash
# Capture SIP traffic
sudo tcpdump -i any -s 0 -w sip-capture.pcap port 5060

# View with Wireshark
wireshark sip-capture.pcap
```

## Comparison with Other Transports

| Feature | 3CX (SIP) | SmartPBX | Twilio |
|---------|-----------|----------|--------|
| **Protocol** | SIP | WebSocket | WebSocket |
| **Setup** | Medium | Easy | Easy |
| **Audio** | 8kHz G.711 | Any | 8kHz G.711 |
| **Outbound** | ✅ Yes | ❌ No | ✅ Yes |
| **Cost** | Server only | Free tier | Pay-per-use |

## Advanced Configuration

### Extension Registration (Alternative)

Instead of SIP trunking, you can register as a 3CX extension:

1. Create extension in 3CX (e.g., `8001`)
2. Configure SIP credentials
3. Update code to register with 3CX
4. Route calls to that extension

This is simpler but less flexible than SIP trunking.

### Outbound Calls

To enable outbound calls from the agent:

1. Create **Outbound Rule** in 3CX
2. Set source to: **Kuralle AI Agent** trunk
3. Agent can now initiate calls via SIP

## Resources

- **3CX SIP Trunk Guide**: https://www.3cx.com/docs/sip-trunk-configuration/
- **Main Documentation**: `../../../docs/3CX_INTEGRATION_SIMPLIFIED.md`
- **SIP Transport Package**: `../../../packages/kuralle-livekit-plugin-transport-sip/`

## Support

For issues or questions:
- Check 3CX logs: **3CX Management Console** → **Activity Log**
- Check Kuralle logs: Server console output
- Verify network connectivity: `telnet <server-ip> 5060`
