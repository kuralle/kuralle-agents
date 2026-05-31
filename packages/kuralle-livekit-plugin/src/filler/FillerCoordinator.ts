import type { voice } from '@livekit/agents';

type FillerSpeakSession = Pick<voice.AgentSession, 'say'>;

export class FillerCoordinator {
  #activeFillers: Set<Promise<void>> = new Set();

  async speakFiller(session: FillerSpeakSession, filler: string): Promise<void> {
    const text = filler.trim();
    if (!text) {
      return;
    }

    const handle = session.say(text, {
      allowInterruptions: true,
      addToChatCtx: false,
    });

    const playout = handle
      .waitForPlayout()
      .catch(() => {
        // Barge-in interruptions are expected and should not fail the pipeline.
      })
      .finally(() => {
        this.#activeFillers.delete(playout);
      });

    this.#activeFillers.add(playout);
  }

  async waitForActiveFillers(): Promise<void> {
    if (this.#activeFillers.size === 0) {
      return;
    }

    await Promise.allSettled([...this.#activeFillers]);
  }
}
