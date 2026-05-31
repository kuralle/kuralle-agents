import { voice } from '@livekit/agents';

// The LiveKit Agent shell. With a Kuralle runtime as the LLM (see src/main.ts),
// the agent's real behavior — instructions, tools, flows, routing — lives in
// src/runtime.ts. Edit that file to change what the bot does.
export class Agent extends voice.Agent {
  constructor() {
    super({
      instructions: 'You are a helpful voice AI assistant.',
    });
  }
}
