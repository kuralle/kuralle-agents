import fs from 'node:fs';
import {
  S3Client,
  type PutObjectCommandInput,
  type StorageClass,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { log } from '@livekit/agents';
import type {
  RecordingMetadata,
  RecordingStorageAdapter,
  UploadedRecording,
} from './storage.js';

function getLogger() {
  return log();
}

export interface S3RecordingAdapterOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  keyPrefix?: string;
  keyGenerator?: (metadata: RecordingMetadata) => string;
  additionalTags?: Record<string, string>;
  storageClass?:
    | 'STANDARD'
    | 'INTELLIGENT_TIERING'
    | 'STANDARD_IA'
    | 'GLACIER_IR'
    | 'GLACIER'
    | (string & {});
  serverSideEncryption?: 'AES256' | 'aws:kms' | (string & {});
  sseKmsKeyId?: string;
  deleteAfterUpload?: boolean;
}

interface ResolvedS3Options
  extends Required<
    Omit<
      S3RecordingAdapterOptions,
      'endpoint' | 'credentials' | 'keyGenerator' | 'sseKmsKeyId'
    >
  > {
  endpoint?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  keyGenerator?: (metadata: RecordingMetadata) => string;
  sseKmsKeyId?: string;
}

function defaultKeyGenerator(prefix: string, metadata: RecordingMetadata): string {
  const date = new Date(metadata.recordingStartedAt);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const safeRoomName = metadata.roomName.replace(/[^a-zA-Z0-9-_]/g, '-');
  return `${prefix}/${year}/${month}/${day}/${safeRoomName}-${metadata.jobId}.ogg`;
}

export class S3RecordingAdapter implements RecordingStorageAdapter {
  #client: S3Client;
  #opts: ResolvedS3Options;

  constructor(opts: S3RecordingAdapterOptions) {
    this.#opts = {
      bucket: opts.bucket,
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? false,
      credentials: opts.credentials,
      keyPrefix: opts.keyPrefix ?? 'recordings',
      keyGenerator: opts.keyGenerator,
      additionalTags: opts.additionalTags ?? {},
      storageClass: opts.storageClass ?? 'STANDARD',
      serverSideEncryption: opts.serverSideEncryption ?? 'AES256',
      sseKmsKeyId: opts.sseKmsKeyId,
      deleteAfterUpload: opts.deleteAfterUpload ?? true,
    };

    this.#client = new S3Client({
      region: this.#opts.region,
      ...(this.#opts.endpoint ? { endpoint: this.#opts.endpoint } : {}),
      ...(this.#opts.forcePathStyle ? { forcePathStyle: true } : {}),
      ...(this.#opts.credentials ? { credentials: this.#opts.credentials } : {}),
    });
  }

  async upload(localPath: string, metadata: RecordingMetadata): Promise<UploadedRecording> {
    const key = this.#opts.keyGenerator
      ? this.#opts.keyGenerator(metadata)
      : defaultKeyGenerator(this.#opts.keyPrefix, metadata);

    const stat = await fs.promises.stat(localPath);
    const fileStream = fs.createReadStream(localPath);

    const tags = {
      jobId: metadata.jobId,
      roomName: metadata.roomName,
      roomSid: metadata.roomSid,
      recordedAt: new Date(metadata.recordingStartedAt).toISOString(),
      durationSeconds: String(Math.round(metadata.durationSeconds)),
      ...metadata.tags,
      ...this.#opts.additionalTags,
    };

    const tagging = Object.entries(tags)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');

    const params: PutObjectCommandInput = {
      Bucket: this.#opts.bucket,
      Key: key,
      Body: fileStream,
      ContentType: 'audio/ogg',
      ContentLength: stat.size,
      StorageClass: this.#opts.storageClass as StorageClass,
      ServerSideEncryption: this.#opts.serverSideEncryption as ServerSideEncryption,
      ...(this.#opts.sseKmsKeyId ? { SSEKMSKeyId: this.#opts.sseKmsKeyId } : {}),
      Tagging: tagging,
      Metadata: {
        'aria-job-id': metadata.jobId,
        'aria-room-name': metadata.roomName,
        'aria-room-sid': metadata.roomSid,
        'aria-recorded-at': new Date(metadata.recordingStartedAt).toISOString(),
        'aria-duration-seconds': String(Math.round(metadata.durationSeconds)),
      },
    };

    getLogger().info(
      { bucket: this.#opts.bucket, key, sizeBytes: stat.size },
      'Uploading recording to S3-compatible storage',
    );

    const upload = new Upload({
      client: this.#client,
      params,
      partSize: 5 * 1024 * 1024,
      queueSize: 2,
    });

    try {
      await upload.done();
    } finally {
      fileStream.destroy();
    }

    const normalizedEndpoint = this.#opts.endpoint?.replace(/\/+$/, '');
    const location = normalizedEndpoint
      ? `${normalizedEndpoint}/${this.#opts.bucket}/${key}`
      : `https://${this.#opts.bucket}.s3.${this.#opts.region}.amazonaws.com/${key}`;

    return {
      location,
      sizeBytes: stat.size,
      metadata,
    };
  }

  async deleteLocal(localPath: string): Promise<void> {
    if (!this.#opts.deleteAfterUpload) {
      return;
    }

    try {
      await fs.promises.unlink(localPath);
    } catch (error) {
      getLogger().warn({ localPath, error }, 'Failed to delete local recording after upload');
    }
  }

  async onUploadError(error: Error, localPath: string, metadata: RecordingMetadata): Promise<void> {
    getLogger().error(
      {
        error: error.message,
        localPath,
        jobId: metadata.jobId,
        roomName: metadata.roomName,
      },
      'Recording upload failed',
    );
  }
}
