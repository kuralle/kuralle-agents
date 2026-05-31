import { h, type JSX } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { WidgetClient, type Message, type AgentConfig } from '../client/WidgetClient';
import './styles.css';

export interface WidgetProps {
  agentUrl: string; // Base HTTP URL for API calls
  agentId: string; // Agent identifier to resolve connection details
  // Legacy support
  widgetId?: string;
  apiUrl?: string;
  // Mode
  mode?: 'chat' | 'voice';
  // Appearance
  theme?: 'light' | 'dark';
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  size?: 'tiny' | 'compact' | 'full';
  radius?: 'none' | 'small' | 'medium' | 'large';
  // Colors
  baseColor?: string;
  accentColor?: string;
  buttonBaseColor?: string;
  buttonAccentColor?: string;
  // Text
  title?: string;
  subtitle?: string;
  emptyChatMessage?: string;
}

// Border radius values
const radiusValues: Record<NonNullable<WidgetProps['radius']>, string> = {
  none: '0',
  small: '0.375rem',
  medium: '0.75rem',
  large: '1rem',
};

export function Widget({
  agentUrl,
  agentId,
  // Legacy props for backward compatibility
  widgetId,
  apiUrl,
  mode = 'chat',
  theme = 'light',
  position = 'bottom-right',
  size = 'full',
  radius = 'medium',
  baseColor,
  accentColor = '#14B8A6',
  buttonBaseColor = '#000000',
  buttonAccentColor = '#FFFFFF',
  title,
  subtitle,
  emptyChatMessage,
}: WidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [isAgentStreaming, setIsAgentStreaming] = useState(false);
  const [isAgentProcessing, setIsAgentProcessing] = useState(false);
  const [queuedMessageCount, setQueuedMessageCount] = useState(0);
  const [activeSuggestions, setActiveSuggestions] = useState<string[]>([]);

  const clientRef = useRef<WidgetClient | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize widget
  useEffect(() => {
    const init = async () => {
      // Support new agent resolution approach
      if (agentUrl && agentId) {
        const client = new WidgetClient(agentUrl, agentId);
        clientRef.current = client;

        try {
          // Subscribe to messages and connection BEFORE initializing
          client.onMessages((msgs) => setMessages(msgs));

          client.onConnectionChange((connected) => {
            setIsConnected(connected);
            // Set initialized to true only after successful connection
            if (connected) {
              setIsInitialized(true);
            }
          });

          client.onStreamingChange((streaming) => setIsAgentStreaming(streaming));

          client.onQueueChange((count) => setQueuedMessageCount(count));

          client.onProcessingChange((processing) => setIsAgentProcessing(processing));
          client.onSuggestionsChange((suggestions) => setActiveSuggestions(suggestions));

          const agentConfig = await client.initWidget();

          if (agentConfig) {
            setConfig(agentConfig);
            // Note: setIsInitialized(true) is now called when WebSocket connects
          } else {
            console.error('[Kuralle Widget] Agent config fetch failed');
          }
        } catch (error) {
          console.error('[Kuralle Widget] Initialization error:', error);
        }
      }
      // Legacy support for direct WebSocket URL (deprecated)
      else if (agentUrl && !agentId) {
        console.warn('[Kuralle Widget] Direct WebSocket URLs are deprecated. Use agent-url + agent-id instead.');
        console.error('[Kuralle Widget] Configuration error: agent-id is required');
      }
      // Legacy widget config approach (deprecated)
      else if (apiUrl && widgetId) {
        console.warn('[Kuralle Widget] Legacy widget config is deprecated. Use agent-url + agent-id instead.');
        console.error('[Kuralle Widget] Configuration error: use agent-url + agent-id instead');
      }
      else {
        console.error('[Kuralle Widget] Invalid configuration. Provide agent-url and agent-id.');
      }
    };

    init();

    return () => {
      clientRef.current?.dispose();
    };
  }, [agentUrl, agentId, widgetId, apiUrl]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async () => {
    if (!inputValue.trim() || !isConnected) return;

    const content = inputValue.trim();
    setInputValue('');

    try {
      await clientRef.current?.sendMessage(content);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleChipClick = (chip: string) => {
    if (!isConnected || isAgentStreaming) return;
    clientRef.current?.sendMessage(chip);
  };

  // Always show launcher button for better UX

  const displayTitle = title || config?.config.title || 'Ninewells Hospital';
  const displaySubtitle = subtitle || config?.config.subtitle || 'How can we help you today?';
  const displayEmptyMessage = emptyChatMessage || config?.config.emptyChatMessage || 'Start a conversation with Ninewells...';

  return (
    <div
      className={`kuralle-widget-container kuralle-widget-${position} kuralle-widget-${size} kuralle-widget-radius-${radius}`}
      data-theme={theme}
      style={
        {
          '--kuralle-accent-color': accentColor,
          '--kuralle-base-color': baseColor,
        } as JSX.CSSProperties
      }
    >
      {/* Launcher Button - Always visible with connection status */}
      {!isOpen && (
        <button
          className="kuralle-widget-launcher"
          onClick={() => setIsOpen(true)}
          style={{
            backgroundColor: buttonBaseColor,
            color: buttonAccentColor,
            opacity: !isInitialized ? 0.8 : 1,
            cursor: !isInitialized ? 'wait' : 'pointer',
            position: 'relative',
          }}
          aria-label={!isInitialized ? "Connecting to agent..." : "Open chat"}
          disabled={!isInitialized}
          title={!isInitialized ? "Connecting to agent..." : "Click to start chat"}
        >
          {/* Loading indicator when connecting */}
          {!isInitialized && (
            <div
              className="kuralle-widget-launcher-loading"
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '20px',
                height: '20px',
                border: `2px solid ${buttonAccentColor}`,
                borderTop: '2px solid transparent',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }}
            />
          )}

          {/* Chat icon - hidden when loading */}
          {isInitialized && (
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          )}
        </button>
      )}

      {/* Chat Window - Only show when initialized */}
      {isOpen && isInitialized && (
        <div
          className="kuralle-widget-window"
          style={{
            backgroundColor: theme === 'dark' && baseColor ? baseColor : undefined,
            borderRadius: radiusValues[radius],
          }}
        >
          {/* Header */}
          <div
            className="kuralle-widget-header"
            style={{
              backgroundColor: accentColor,
              borderRadius: radius === 'none'
                ? '0'
                : `${radiusValues[radius]} ${radiusValues[radius]} 0 0`,
            }}
          >
            <div className="kuralle-widget-header-content">
              <div className="kuralle-widget-title-group">
                <h3 className="kuralle-widget-title">{displayTitle}</h3>
                <p className="kuralle-widget-subtitle">{displaySubtitle}</p>
              </div>
            </div>
            <button
              className="kuralle-widget-close"
              onClick={() => setIsOpen(false)}
              aria-label="Close chat"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Connection Status */}
          {!isConnected && (
            <div className="kuralle-widget-status">
              <span className="kuralle-widget-status-dot" />
              Connecting...
            </div>
          )}

          {/* Messages */}
          <div className="kuralle-widget-messages">
            {messages.length === 0 ? (
              <div className="kuralle-widget-empty">
                <p>{isConnected ? displayEmptyMessage : 'Connecting to agent...'}</p>
              </div>
            ) : (
              <>
                {messages.map((message) => {
                  // Don't render tool messages in the UI
                  if (message.role === 'tool') return null;

                  return (
                    <div
                      key={message.id}
                      className={`kuralle-widget-message kuralle-widget-message-${message.role}`}
                    >
                      <div className="kuralle-widget-message-bubble">
                        <>
                          {message.content}
                          {message.isStreaming && (
                            <span className="kuralle-widget-typing-indicator">
                              <span>•</span><span>•</span><span>•</span>
                            </span>
                          )}
                        </>
                      </div>

                    </div>
                  );
                })}
                <div ref={messagesEndRef} />

                {/* Processing Indicator */}
                {isAgentProcessing && !isAgentStreaming && (
                  <div className="kuralle-widget-message kuralle-widget-message-assistant">
                    <div className="kuralle-widget-message-bubble">
                      <span className="kuralle-widget-typing-indicator">
                        <span>•</span><span>•</span><span>•</span>
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Floating Suggestions */}
          {!isAgentStreaming && activeSuggestions.length > 0 && (
            <div className="kuralle-widget-suggestions">
              {activeSuggestions.map((chip) => (
                <button
                  key={chip}
                  className="kuralle-widget-chip"
                  onClick={() => handleChipClick(chip)}
                  style={{
                    borderColor: accentColor,
                    color: accentColor,
                    backgroundColor: 'rgba(255, 255, 255, 0.95)',
                    backdropFilter: 'blur(4px)'
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="kuralle-widget-input">
            <textarea
              value={inputValue}
              onInput={(e) => setInputValue((e.target as HTMLTextAreaElement).value)}
              onKeyDown={handleKeyDown}
              placeholder={
                !isConnected
                  ? "Connecting..."
                  : isAgentStreaming
                    ? queuedMessageCount > 0
                      ? `Agent is responding... (${queuedMessageCount} message${queuedMessageCount > 1 ? 's' : ''} queued)`
                      : "Agent is responding..."
                    : "Type your message..."
              }
              rows={1}
              disabled={!isConnected}
            />
            <button
              className="kuralle-widget-send"
              onClick={handleSendMessage}
              disabled={!inputValue.trim() || !isConnected}
              style={{ backgroundColor: accentColor }}
              aria-label="Send message"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
