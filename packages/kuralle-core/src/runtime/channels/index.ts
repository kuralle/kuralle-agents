export type { ChannelDriver } from '../../types/channel.js';
export { TextDriver, buildNodePrompt } from './TextDriver.js';
export type { TextDriverConfig } from './TextDriver.js';
// PAUSED: the realtime VoiceDriver is not on the primary (text) path and is not
// re-exported from the package's headline API. It stays here for the realtime
// stack (`@kuralle-agents/realtime-audio`) via the `/runtime` subpath. Text is
// the primary primitive; cascaded voice runs over text (see livekit-plugin).
export { VoiceDriver } from './VoiceDriver.js';
export type { VoiceDriverConfig } from './VoiceDriver.js';
export { resolveVoiceGeminiTools, v2ToolsToGemini } from './voiceTools.js';
export { setPendingUserInput, consumePendingUserInput, peekPendingUserInput } from './inputBuffer.js';
