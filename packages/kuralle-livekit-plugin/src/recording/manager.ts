import fs from 'node:fs';
import { log, type JobContext, voice } from '@livekit/agents';
import type { RecordingMetadata, RecordingStorageAdapter } from './storage.js';

function getLogger() {
  return log();
}

export interface RecordingManagerOptions {
  adapter: RecordingStorageAdapter;
  session: voice.AgentSession;
  ctx: JobContext;
  tags?: Record<string, string>;
}

export class RecordingManager {
  #opts: RecordingManagerOptions;
  #attached = false;

  constructor(opts: RecordingManagerOptions) {
    this.#opts = opts;
  }

  attach(): void {
    if (this.#attached) {
      return;
    }
    this.#attached = true;

    const { session, ctx } = this.#opts;

    // Suppress cloud upload before JobContext._onSessionEnd() is called.
    // WARNING: accesses AgentSession private internals. Pin @livekit/agents version.
    session.on(voice.AgentSessionEventTypes.Close, () => {
      if (typeof session._enableRecording === 'boolean') {
        session._enableRecording = false;
      } else {
        getLogger().warn(
          'RecordingManager: AgentSession._enableRecording not found. ' +
          '@livekit/agents internals may have changed.',
        );
      }
    });

    ctx.addShutdownCallback(async () => {
      const recorder = session._recorderIO;
      if (!recorder) {
        getLogger().debug('RecordingManager: no RecorderIO found, skipping upload');
        return;
      }

      if (recorder.recording && recorder.close) {
        await recorder.close();
      }

      const localPath = recorder.outputPath;
      const recordingStartedAt = recorder.recordingStartedAt;

      if (!localPath || !recordingStartedAt) {
        getLogger().warn('RecordingManager: missing local path or recording start time, skipping');
        return;
      }

      if (!fs.existsSync(localPath)) {
        getLogger().warn({ localPath }, 'RecordingManager: local recording file missing');
        return;
      }

      const stat = fs.statSync(localPath);
      if (stat.size === 0) {
        getLogger().warn({ localPath }, 'RecordingManager: empty recording file, skipping upload');
        return;
      }

      const metadata: RecordingMetadata = {
        jobId: ctx.job.id,
        roomName: ctx.job.room?.name ?? 'unknown',
        roomSid: ctx.job.room?.sid ?? 'unknown',
        recordingStartedAt,
        durationSeconds: (Date.now() - recordingStartedAt) / 1000,
        tags: this.#opts.tags,
      };

      try {
        const result = await this.#opts.adapter.upload(localPath, metadata);
        getLogger().info(
          {
            location: result.location,
            sizeBytes: result.sizeBytes,
            jobId: metadata.jobId,
          },
          'RecordingManager: uploaded call recording',
        );

        await this.#opts.adapter.deleteLocal?.(localPath);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        getLogger().error(
          { error: normalized.message, localPath },
          'RecordingManager: failed to upload recording',
        );
        await this.#opts.adapter.onUploadError?.(normalized, localPath, metadata);
      }
    });
  }
}
