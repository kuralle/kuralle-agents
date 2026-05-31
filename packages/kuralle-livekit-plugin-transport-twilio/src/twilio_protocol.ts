/**
 * Twilio Media Streams protocol message types and handlers.
 *
 * Twilio's Media Streams API sends JSON events over WebSocket:
 * - Media events: Audio data with base64 payload
 * - Control events: connected, disconnected, started, stopped
 * - Metadata: marks/custom events
 *
 * Reference: https://www.twilio.com/docs/voice/media-streams
 */

/**
 * Twilio Media Streams event types.
 */
type TwilioEventType =
  | 'connected'
  | 'start'
  | 'media'
  | 'stop'
  | 'mark'
  | 'clear';

/**
 * Base interface for all Twilio events.
 */
export interface TwilioEvent {
  event: TwilioEventType;
  sequenceNumber?: string;
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // Base64-encoded μ-law audio
  };
  start?: {
    streamSid: string;
    callSid: string;
    tracks?: string[];
    mediaFormat?: {
      encoding: 'audio/x-mulaw' | 'mulaw';
      sampleRate: 8000;
      channels: 1;
    };
  };
  mark?: {
    name: string;
  };
  streamSid?: string;
}

/**
 * Media event with audio data.
 */
export interface TwilioMediaEvent extends TwilioEvent {
  event: 'media';
  media: {
    track: string; // 'inbound' or 'outbound'
    chunk: string; // Chunk sequence number
    timestamp: string; // Timestamp in milliseconds
    payload: string; // Base64-encoded μ-law audio data
  };
}

/**
 * Connected event - stream established.
 */
export interface TwilioConnectedEvent extends TwilioEvent {
  event: 'connected';
  streamSid: string;
  callSid: string;
}

/**
 * Started event - media transmission began.
 */
export interface TwilioStartEvent extends TwilioEvent {
  event: 'start';
  start: {
    streamSid: string;
    callSid: string;
    tracks?: string[];
    mediaFormat?: {
      encoding: 'audio/x-mulaw' | 'mulaw';
      sampleRate: 8000;
      channels: 1;
    };
  };
  streamSid?: string;
}

/**
 * Stopped event - media transmission ended.
 */
export interface TwilioStopEvent extends TwilioEvent {
  event: 'stop';
  streamSid: string;
  callSid: string;
}

/**
 * Mark event - custom metadata from TwiML.
 */
export interface TwilioMarkEvent extends TwilioEvent {
  event: 'mark';
  streamSid: string;
  mark: {
    name: string;
  };
}

/**
 * Clear event - clears buffered audio.
 */
export interface TwilioClearEvent extends TwilioEvent {
  event: 'clear';
  streamSid: string;
}

/**
 * Parse a JSON message from Twilio Media Streams.
 *
 * @param message - Raw JSON string from WebSocket
 * @returns Parsed Twilio event or null if invalid
 */
export function parseTwilioMessage(message: string): TwilioEvent | null {
  try {
    const event = JSON.parse(message) as TwilioEvent;

    // Validate event has required fields
    if (!event.event) {
      return null;
    }

    // Validate event type
    const validEvents: TwilioEventType[] = ['connected', 'start', 'media', 'stop', 'mark', 'clear'];
    if (!validEvents.includes(event.event)) {
      return null;
    }

    return event;
  } catch {
    return null;
  }
}

/**
 * Check if an event is a media event with audio data.
 */
export function isMediaEvent(event: TwilioEvent): event is TwilioMediaEvent {
  return event.event === 'media' && event.media !== undefined && typeof event.media.payload === 'string';
}

/**
 * Extract μ-law audio payload from a media event.
 *
 * @param event - Twilio media event
 * @returns Base64-encoded μ-law audio data or null
 */
export function extractMediaPayload(event: TwilioMediaEvent): string | null {
  if (event.media && event.media.payload) {
    return event.media.payload;
  }
  return null;
}

/**
 * Create a clear message to send to Twilio (clears audio buffer).
 */
export function createClearMessage(): string {
  return JSON.stringify({
    event: 'clear',
    streamSid: '', // Will be filled by sender
    sequenceNumber: `${Date.now()}`,
  });
}

/**
 * Create a mark message (adds metadata to the stream).
 */
export function createMarkMessage(name: string): string {
  return JSON.stringify({
    event: 'mark',
    streamSid: '', // Will be filled by sender
    sequenceNumber: `${Date.now()}`,
    mark: { name },
  });
}
