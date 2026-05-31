/**
 * Google Cloud Speech-to-Text STT for LiveKit Agents (Node.js).
 *
 * Ports the LiveKit Python google STT plugin to Node.js.
 * Uses @google-cloud/speech v2 API with gRPC streaming.
 *
 * Supports Sinhala (si-LK), Hindi (hi-IN), Tamil (ta-IN), and 100+ other languages.
 *
 * Credentials:
 *   Set GOOGLE_APPLICATION_CREDENTIALS env var to your service account JSON path,
 *   or pass keyFilename/credentials in the constructor.
 *
 * Usage:
 *   import { GoogleSTT } from './google-stt.mjs';
 *   const stt = new GoogleSTT({ languages: ['si-LK', 'en-US'], projectId: 'my-project' });
 */

import { stt, log, AudioByteStream } from '@livekit/agents';
import { SpeechClient } from '@google-cloud/speech/build/src/v2/index.js';

const MAX_SESSION_DURATION = 240;

const defaultOptions = {
  languages: ['en-US'],
  detectLanguage: true,
  interimResults: true,
  punctuate: true,
  model: 'latest_long',
  location: 'global',
  sampleRate: 16000,
  minConfidence: 0.65,
};

export class GoogleSTT extends stt.STT {
  #opts;
  #client;
  #projectId;

  label = 'google.STT';

  constructor(opts = {}) {
    super({
      streaming: true,
      interimResults: opts.interimResults ?? defaultOptions.interimResults,
      alignedTranscript: 'word',
    });

    this.#opts = { ...defaultOptions, ...opts };

    const clientOpts = {};
    if (opts.keyFilename) clientOpts.keyFilename = opts.keyFilename;
    if (opts.credentials) clientOpts.credentials = opts.credentials;
    // Support credentials as JSON string in env var (for container deployments)
    if (!opts.credentials && !opts.keyFilename && process.env.GCP_CREDENTIALS_JSON) {
      try { clientOpts.credentials = JSON.parse(process.env.GCP_CREDENTIALS_JSON); } catch { /* ignore */ }
    }
    if (opts.projectId) clientOpts.projectId = opts.projectId;
    if (opts.location && opts.location !== 'global') {
      clientOpts.apiEndpoint = `${opts.location}-speech.googleapis.com`;
    }

    this.#client = new SpeechClient(clientOpts);
    this.#projectId = opts.projectId || process.env.GOOGLE_CLOUD_PROJECT || '';
  }

  get model() { return this.#opts.model; }
  get provider() { return 'Google Cloud Speech'; }

  async _recognize() {
    throw new Error('Batch recognition not supported — use streaming');
  }

  stream(options) {
    return new GoogleSpeechStream(this, this.#client, this.#opts, this.#projectId, options?.connOptions);
  }

  async close() {
    // gRPC client cleanup
  }
}

class GoogleSpeechStream extends stt.SpeechStream {
  label = 'google.SpeechStream';
  #client;
  #opts;
  #projectId;
  #logger = log();
  #speaking = false;
  #sessionStartedAt = 0;

  constructor(stt, client, opts, projectId, connOptions) {
    super(stt, opts.sampleRate, connOptions);
    this.#client = client;
    this.#opts = opts;
    this.#projectId = projectId;
  }

  async run() {
    while (!this.input.closed && !this.closed) {
      try {
        await this.#runSession();
      } catch (e) {
        if (this.closed || this.input.closed) return;
        throw e;
      }
    }
  }

  async #runSession() {
    const recognizer = `projects/${this.#projectId}/locations/${this.#opts.location}/recognizers/_`;

    const streamingConfig = {
      config: {
        explicitDecodingConfig: {
          encoding: 'LINEAR16',
          sampleRateHertz: this.#opts.sampleRate,
          audioChannelCount: 1,
        },
        languageCodes: this.#opts.languages,
        model: this.#opts.model,
      },
      streamingFeatures: {
        interimResults: this.#opts.interimResults,
        enableVoiceActivityEvents: true,
      },
    };

    const stream = this.#client._streamingRecognize();

    // Send config as first message
    stream.write({ recognizer, streamingConfig });

    this.#sessionStartedAt = Date.now();

    // Send audio from this.input to gRPC stream
    const sendLoop = async () => {
      const samples100ms = Math.floor(this.#opts.sampleRate / 10);
      const audioBuffer = new AudioByteStream(this.#opts.sampleRate, 1, samples100ms);

      try {
        while (!this.closed && !this.input.closed) {
          const result = await Promise.race([
            this.input.next(),
            new Promise((_, reject) => {
              if (this.abortSignal.aborted) reject(new Error('aborted'));
              this.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
          ]);

          if (!result || result.done) break;

          const data = result.value;
          if (data === GoogleSpeechStream.FLUSH_SENTINEL) {
            const frames = audioBuffer.flush();
            for await (const frame of frames) {
              stream.write({ audio: Buffer.from(frame.data.buffer) });
            }
          } else {
            const frames = audioBuffer.write(data.data.buffer);
            for await (const frame of frames) {
              stream.write({ audio: Buffer.from(frame.data.buffer) });
            }
          }
        }
      } finally {
        stream.end();
      }
    };

    // Receive results from gRPC stream
    const receiveLoop = () => new Promise((resolve, reject) => {
      stream.on('data', (response) => {
        this.#handleResponse(response);

        // Check session timeout (Google has ~5min limit)
        if (Date.now() - this.#sessionStartedAt > MAX_SESSION_DURATION * 1000) {
          this.#logger.debug('Google STT max session duration reached, reconnecting...');
          stream.end();
        }
      });

      stream.on('error', (err) => {
        reject(err);
      });

      stream.on('end', () => {
        resolve();
      });
    });

    await Promise.all([sendLoop(), receiveLoop()]);
  }

  #handleResponse(response) {
    const put = (event) => {
      if (!this.queue.closed) {
        try { this.queue.put(event); } catch { /* closed */ }
      }
    };

    // Handle voice activity events
    const eventType = response.speechEventType;
    if (eventType === 'SPEECH_ACTIVITY_BEGIN') {
      if (!this.#speaking) {
        this.#speaking = true;
        put({ type: stt.SpeechEventType.START_OF_SPEECH });
      }
      return;
    }

    if (eventType === 'SPEECH_ACTIVITY_END') {
      this.#speaking = false;
      put({ type: stt.SpeechEventType.END_OF_SPEECH });
      return;
    }

    // Handle recognition results
    if (!response.results || response.results.length === 0) return;

    const result = response.results[0];
    if (!result.alternatives || result.alternatives.length === 0) return;

    const alt = result.alternatives[0];
    if (!alt.transcript) return;

    if (!this.#speaking) {
      this.#speaking = true;
      put({ type: stt.SpeechEventType.START_OF_SPEECH });
    }

    const speechData = {
      language: result.languageCode || this.#opts.languages[0] || 'en-US',
      startTime: 0,
      endTime: 0,
      confidence: alt.confidence || 0,
      text: alt.transcript,
    };

    // Word-level timing if available
    if (alt.words && alt.words.length > 0) {
      speechData.startTime = Number(alt.words[0].startTime?.seconds || 0) + (alt.words[0].startTime?.nanos || 0) / 1e9 + this.startTimeOffset;
      speechData.endTime = Number(alt.words[alt.words.length - 1].endTime?.seconds || 0) + (alt.words[alt.words.length - 1].endTime?.nanos || 0) / 1e9 + this.startTimeOffset;
      speechData.words = alt.words.map(w => ({
        text: w.word || '',
        startTime: Number(w.startTime?.seconds || 0) + (w.startTime?.nanos || 0) / 1e9 + this.startTimeOffset,
        endTime: Number(w.endTime?.seconds || 0) + (w.endTime?.nanos || 0) / 1e9 + this.startTimeOffset,
        confidence: w.confidence || 0,
      }));
    }

    if (result.isFinal) {
      put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [speechData],
      });
    } else {
      if (speechData.confidence < this.#opts.minConfidence && speechData.confidence > 0) return;
      put({
        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives: [speechData],
      });
    }
  }
}
