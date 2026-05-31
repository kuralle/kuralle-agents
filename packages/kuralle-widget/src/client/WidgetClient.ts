import { nanoid } from 'nanoid';
import { debug } from '../debug.js';

export interface AgentConfig {
  id: string;
  name: string;
  wsUrl: string;
  status: 'active' | 'inactive';
  capabilities: string[];
  config: {
    primaryColor?: string;
    position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
    theme?: "light" | "dark";
    title?: string;
    subtitle?: string;
    avatarUrl?: string;
    maxRetries?: number;
    reconnectDelay?: number;
    emptyChatMessage?: string;
  };
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  toolCall?: {
    name: string;
    arguments: unknown;
  };
  toolResult?: unknown;
  isStreaming?: boolean;
  suggestions?: string[];
}

/**
 * WidgetClient - Handles direct WebSocket connection to the agent.
 * No Convex dependency - fetches config from TanStack Start API, then connects directly to agent.
 */
export class WidgetClient {
  private agentConfig: AgentConfig | null = null;
  private ws: WebSocket | null = null;
  private messageCallbacks: Set<(messages: Message[]) => void> = new Set();
  private suggestionsCallbacks: Set<(suggestions: string[]) => void> = new Set();
  private connectionCallbacks: Set<(connected: boolean) => void> = new Set();
  private streamingCallbacks: Set<(streaming: boolean) => void> = new Set();
  private processingCallbacks: Set<(processing: boolean) => void> = new Set();
  private queueCallbacks: Set<(count: number) => void> = new Set();
  private messages: Message[] = [];
  private activeSuggestions: string[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isAgentStreaming = false;
  private isAgentProcessing = false;
  private messageQueue: string[] = [];
  private disposed = false;

  constructor(private agentUrl: string, private agentId: string) { }

  /**
   * Initialize the widget by fetching agent configuration
   */
  async initWidget(): Promise<AgentConfig | null> {
    try {
      // Try the new agent config endpoint first
      try {
        const response = await fetch(`${this.normalizeBaseUrl(this.agentUrl)}/api/agent/${this.agentId}`);
        if (response.ok) {
          const agentConfig = await response.json() as AgentConfig;

          if (!agentConfig || agentConfig.status !== 'active') {
            console.error("Agent not found or inactive");
            return null;
          }

          this.agentConfig = agentConfig;

          // Update reconnect settings from config
          this.maxReconnectAttempts = agentConfig.config.maxRetries || 5;
          this.reconnectDelay = agentConfig.config.reconnectDelay || 1000;

          // Connect to agent via WebSocket
          await this.connectToAgent();

          return agentConfig;
        }
      } catch (configError) {
        console.warn('[Kuralle Widget] Agent config endpoint not available, trying fallback');
      }

      // Fallback to default Kuralle router endpoint used by widgets.
      const wsBaseUrl = this.toWebSocketBaseUrl(this.normalizeBaseUrl(this.agentUrl));
      const fallbackConfig: AgentConfig = {
        id: this.agentId,
        name: this.agentId === 'hospital' ? 'Hospital Support' : 'Support Agent',
        wsUrl: `${wsBaseUrl}/agents/chat`,
        status: 'active',
        capabilities: ['chat', 'streaming'],
        config: {
          primaryColor: "#14B8A6",
          position: "bottom-right",
          theme: "light",
          title: this.agentId === 'hospital' ? "Hospital Support" : "Chat Support",
          subtitle: "We're here to help!",
          maxRetries: 3,
          reconnectDelay: 1000
        }
      };

      this.agentConfig = fallbackConfig;

      // Connect to agent via WebSocket
      await this.connectToAgent();

      return fallbackConfig;
    } catch (error) {
      console.error("Failed to initialize widget:", error);
      return null;
    }
  }

  /**
   * Connect to the agent via WebSocket using resolved config
   */
  private async connectToAgent(): Promise<void> {
    if (!this.agentConfig?.wsUrl) {
      throw new Error("No agent WebSocket URL configured");
    }

    if (this.disposed) {
      return;
    }

    const sessionId = this.getSessionId();
    const wsUrl = `${this.normalizeBaseUrl(this.agentConfig.wsUrl)}/${sessionId}`;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          debug("[Widget] Connected to agent");
          this.reconnectAttempts = 0;
          this.notifyConnectionChange(true);
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event);
        };

        this.ws.onclose = () => {
          this.ws = null;
          this.notifyConnectionChange(false);

          // Attempt to reconnect
          if (!this.disposed && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
            debug(`[Widget] Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts})`);
            setTimeout(() => this.connectToAgent(), delay);
          }
        };

        this.ws.onerror = (error) => {
          console.error("[Widget] WebSocket error:", error);
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Register a callback for processing state changes
   */
  onProcessingChange(callback: (processing: boolean) => void): () => void {
    this.processingCallbacks.add(callback);
    return () => {
      this.processingCallbacks.delete(callback);
    };
  }

  /**
   * Notify all processing callbacks
   */
  private notifyProcessingChange(processing: boolean): void {
    this.isAgentProcessing = processing;
    this.processingCallbacks.forEach((cb) => cb(processing));
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "connected") {
        this.notifyConnectionChange(true);
      } else if (data.type === "text-delta") {
        // Stop processing indicator when text starts streaming
        if (this.isAgentProcessing) {
          this.notifyProcessingChange(false);
        }

        // Streaming response - append to last assistant message
        this.setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.isStreaming) {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content + data.text },
            ];
          }
          // Start new streaming message
          return [
            ...prev,
            {
              id: nanoid(),
              role: "assistant",
              content: data.text,
              timestamp: Date.now(),
              isStreaming: true
            },
          ];
        });
      } else if (data.type === "done") {
        this.notifyProcessingChange(false);
        // Mark last message as no longer streaming
        this.setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.isStreaming) {
            return [
              ...prev.slice(0, -1),
              { ...last, isStreaming: false },
            ];
          }
          return prev;
        });
        this.isAgentStreaming = false;
        this.notifyStreamingChange(false);
        // Send queued messages if any
        this.processMessageQueue();
      } else if (data.type === "step-start" || data.type === "agent-start") {
        this.isAgentStreaming = true;
        this.notifyStreamingChange(true);
        // Start processing indicator
        this.notifyProcessingChange(true);
      } else if (data.type === "step-end" || data.type === "agent-end") {
        if (data.type === "agent-end") {
          this.notifyProcessingChange(false);
        }
      } else if (data.type === "tool-call") {
        // Handle both nested tool object (legacy) and flat structure (current)
        const toolName = data.tool?.name || data.toolName;
        const toolArgs = data.tool?.arguments || data.args;

        // Tool call implies processing
        this.notifyProcessingChange(true);

        // Normalize suggestion chips emitted via a tool call.
        if (toolName === 'suggest_options' && toolArgs?.options) {
          this.setActiveSuggestions(toolArgs.options);
        }
      } else if (data.type === "tool-result") {
        // Tool result does not directly affect widget UI state.
      } else if (data.type === "handoff") {
        // Optional metadata event, no UI update required.
      } else if (data.type === "suggested-questions") {
        this.setActiveSuggestions(data.suggestions);
      } else if (data.type === "error" || data.type === "interrupted") {
        this.notifyProcessingChange(false);
        this.isAgentStreaming = false;
        this.notifyStreamingChange(false);
      } else if (data.type === "cancelled") {
        this.notifyProcessingChange(false);
      } else {
        debug("[Widget] Unknown message type:", data.type);
      }
    } catch (error) {
      console.error("[Widget] Error parsing message:", event.data, error);
    }
  }

  /**
   * Send a message via WebSocket
   */
  async sendMessage(content: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to agent");
    }

    this.setActiveSuggestions([]);

    // Add user message locally
    const userMessage: Message = {
      id: nanoid(),
      role: "user",
      content,
      timestamp: Date.now(),
    };
    this.setMessages((prev) => [...prev, userMessage]);

    // If agent is streaming, queue the message
    if (this.isAgentStreaming) {
      debug("[Widget] Agent is streaming, queuing message");
      this.messageQueue.push(content);
      this.notifyQueueChange(this.messageQueue.length);
      return;
    }

    // Send immediately
    this.sendToAgent(content);
  }

  /**
   * Send message to agent via WebSocket
   */
  private async sendToAgent(content: string): Promise<void> {
    const sessionId = this.getSessionId();
    this.ws!.send(JSON.stringify({ message: content, sessionId }));
  }

  /**
   * Process queued messages when agent is done streaming
   */
  private async processMessageQueue(): Promise<void> {
    if (this.messageQueue.length === 0) return;

    if (this.messageQueue.length === 1) {
      // Send single queued message
      const content = this.messageQueue.shift()!;
      debug("[Widget] Sending queued message:", content);
      this.sendToAgent(content);
    } else {
      // Combine multiple messages into one
      const combinedContent = this.messageQueue.join("\n\n");
      this.messageQueue.length = 0; // Clear queue
      debug("[Widget] Sending combined queued messages:", combinedContent);
      this.sendToAgent(combinedContent);
    }
    this.notifyQueueChange(this.messageQueue.length);
  }

  /**
   * Get or generate session ID
   */
  private getSessionId(): string {
    let sessionId = sessionStorage.getItem("kuralle_session_id");
    if (!sessionId) {
      sessionId = nanoid();
      sessionStorage.setItem("kuralle_session_id", sessionId);
    }
    return sessionId;
  }

  /**
   * Update messages state
   */
  private setMessages(updater: (prev: Message[]) => Message[]): void {
    this.messages = updater(this.messages);
    this.messageCallbacks.forEach((cb) => cb(this.messages));
  }

  /**
   * Register a callback for message updates
   */
  onMessages(callback: (messages: Message[]) => void): () => void {
    this.messageCallbacks.add(callback);
    callback(this.messages); // Send current messages immediately
    return () => {
      this.messageCallbacks.delete(callback);
    };
  }

  /**
   * Register a callback for connection state changes
   */
  onConnectionChange(callback: (connected: boolean) => void): () => void {
    this.connectionCallbacks.add(callback);
    return () => {
      this.connectionCallbacks.delete(callback);
    };
  }

  /**
   * Register a callback for streaming state changes
   */
  onStreamingChange(callback: (streaming: boolean) => void): () => void {
    this.streamingCallbacks.add(callback);
    return () => {
      this.streamingCallbacks.delete(callback);
    };
  }

  /**
   * Register a callback for queue count changes
   */
  onQueueChange(callback: (count: number) => void): () => void {
    this.queueCallbacks.add(callback);
    return () => {
      this.queueCallbacks.delete(callback);
    };
  }

  /**
   * Notify all connection callbacks
   */
  private notifyConnectionChange(connected: boolean): void {
    this.connectionCallbacks.forEach((cb) => cb(connected));
  }

  /**
   * Notify all streaming callbacks
   */
  private notifyStreamingChange(streaming: boolean): void {
    this.streamingCallbacks.forEach((cb) => cb(streaming));
  }

  /**
   * Notify all queue callbacks
   */
  private notifyQueueChange(count: number): void {
    this.queueCallbacks.forEach((cb) => cb(count));
  }

  /**
   * Register a callback for active suggestion updates
   */
  onSuggestionsChange(callback: (suggestions: string[]) => void): () => void {
    this.suggestionsCallbacks.add(callback);
    callback(this.activeSuggestions);
    return () => {
      this.suggestionsCallbacks.delete(callback);
    };
  }

  /**
   * Normalize and notify suggestion changes
   */
  private setActiveSuggestions(suggestions: unknown): void {
    const normalized = Array.isArray(suggestions)
      ? suggestions
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];

    const uniqueSuggestions = [...new Set(normalized)];
    this.activeSuggestions = uniqueSuggestions;
    this.suggestionsCallbacks.forEach((cb) => cb(uniqueSuggestions));
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private toWebSocketBaseUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        parsed.protocol = 'wss:';
      } else if (parsed.protocol === 'http:') {
        parsed.protocol = 'ws:';
      }
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return url
        .replace(/^https:\/\//, 'wss://')
        .replace(/^http:\/\//, 'ws://')
        .replace(/\/+$/, '');
    }
  }

  /**
   * Get current messages
   */
  getMessages(): Message[] {
    return this.messages;
  }

  /**
   * Get the current agent configuration
   */
  getConfig(): AgentConfig | null {
    return this.agentConfig;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Disconnect and cleanup
   */
  dispose(): void {
    this.disposed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.messageCallbacks.clear();
    this.suggestionsCallbacks.clear();
    this.connectionCallbacks.clear();
    this.streamingCallbacks.clear();
    this.processingCallbacks.clear();
    this.queueCallbacks.clear();
  }
}
