import { useVoiceAgent } from "@cloudflare/voice/react";
import type { CSSProperties } from "react";

// Per-user Durable Object identity — mirrors Cloudflare's own
// `workspace-chat` example (agents/examples/workspace-chat/src/client.tsx:42).
// Without this, every browser lands on the DO named "default" and shares
// state (your call, mine, and everyone else's). UUID persists in localStorage
// so reloads reconnect to the same DO, but different browsers get different
// DOs and are fully isolated.
const STORAGE_KEY = "kuralle-cf-voice-gemini-flow-user-id";
function getUserId(): string {
  if (typeof window === "undefined") return "default";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

const styles: Record<string, CSSProperties> = {
  page: {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    maxWidth: 720,
    margin: "40px auto",
    padding: "0 24px",
    color: "#1a1a1a",
  },
  header: { marginBottom: 24 },
  title: { margin: 0, fontSize: 28, fontWeight: 600 },
  subtitle: { margin: "6px 0 0", color: "#555", fontSize: 14 },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderRadius: 8,
    background: "#f5f5f7",
    marginBottom: 16,
    fontSize: 14,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    display: "inline-block",
  },
  buttons: { display: "flex", gap: 10, marginBottom: 24 },
  button: {
    padding: "10px 18px",
    fontSize: 15,
    borderRadius: 8,
    border: "1px solid #d0d0d5",
    background: "white",
    cursor: "pointer",
    fontWeight: 500,
  },
  startButton: {
    padding: "10px 18px",
    fontSize: 15,
    borderRadius: 8,
    border: "none",
    background: "#007aff",
    color: "white",
    cursor: "pointer",
    fontWeight: 500,
  },
  sectionTitle: {
    margin: "18px 0 6px",
    fontSize: 13,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#666",
  },
  interim: {
    padding: "10px 14px",
    borderRadius: 8,
    background: "#fffbea",
    border: "1px solid #f1d990",
    fontStyle: "italic",
    minHeight: 20,
  },
  transcriptList: {
    padding: 0,
    margin: 0,
    listStyle: "none",
    borderTop: "1px solid #ececec",
  },
  transcriptItem: {
    padding: "10px 4px",
    borderBottom: "1px solid #ececec",
    fontSize: 15,
  },
  roleUser: { fontWeight: 600, color: "#007aff" },
  roleAssistant: { fontWeight: 600, color: "#34c759" },
  error: {
    padding: "10px 14px",
    borderRadius: 8,
    background: "#fff1f0",
    border: "1px solid #ffa39e",
    color: "#a8071a",
    marginBottom: 16,
    fontSize: 14,
  },
};

const STATUS_COLORS: Record<string, string> = {
  idle: "#8e8e93",
  connecting: "#ff9500",
  listening: "#34c759",
  thinking: "#007aff",
  speaking: "#af52de",
};

export function App() {
  const {
    status,
    transcript,
    interimTranscript,
    audioLevel,
    isMuted,
    connected,
    error,
    startCall,
    endCall,
    toggleMute,
  } = useVoiceAgent({
    agent: "CfVoiceRealtimeFlowAgent",
    name: getUserId(),
  });

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>Kuralle Realtime Voice — Flow Agent</h1>
        <p style={styles.subtitle}>
          E-commerce flow (hub ↔ tracking) on Gemini 3.1 Flash Live Preview, Cloudflare Workers.
        </p>
      </header>

      {error && <div style={styles.error}>⚠️ {error}</div>}

      <div style={styles.statusRow}>
        <span
          style={{
            ...styles.dot,
            background: STATUS_COLORS[status] ?? "#8e8e93",
          }}
        />
        <span>
          <strong>{status}</strong>
          {connected ? " · connected" : " · disconnected"}
          {isMuted ? " · muted" : ""}
          {audioLevel > 0.01
            ? ` · ${Math.round(audioLevel * 100)}%`
            : ""}
        </span>
      </div>

      <div style={styles.buttons}>
        {status === "idle" ? (
          <button
            type="button"
            style={styles.startButton}
            onClick={() => {
              void startCall();
            }}
          >
            Start call
          </button>
        ) : (
          <button type="button" style={styles.button} onClick={endCall}>
            End call
          </button>
        )}
        <button type="button" style={styles.button} onClick={toggleMute} disabled={status === "idle"}>
          {isMuted ? "Unmute" : "Mute"}
        </button>
      </div>

      <div style={styles.sectionTitle}>Interim</div>
      <div style={styles.interim}>{interimTranscript ?? "…"}</div>

      <div style={styles.sectionTitle}>Transcript</div>
      <ul style={styles.transcriptList}>
        {transcript.length === 0 && (
          <li style={{ ...styles.transcriptItem, color: "#888", fontStyle: "italic" }}>
            Nothing yet. Start a call and try: <em>"Hey, what's the weather in Tokyo?"</em>
          </li>
        )}
        {transcript.map((m, i) => (
          <li key={`${m.timestamp}-${i}`} style={styles.transcriptItem}>
            <span
              style={m.role === "user" ? styles.roleUser : styles.roleAssistant}
            >
              {m.role === "user" ? "You" : "Assistant"}:
            </span>{" "}
            {m.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
