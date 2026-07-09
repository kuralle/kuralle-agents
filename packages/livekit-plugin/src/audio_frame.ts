// Re-export AudioFrame from @livekit/rtc-node.
// This single indirection point isolates all downstream packages from the
// native dependency. When a pure-JS AudioFrame shim is available, only
// this file needs to change.
export { AudioFrame } from '@livekit/rtc-node';
