export interface RecordingMetadata {
  jobId: string;
  roomName: string;
  roomSid: string;
  recordingStartedAt: number;
  durationSeconds: number;
  tags?: Record<string, string>;
}

export interface UploadedRecording {
  location: string;
  sizeBytes: number;
  metadata: RecordingMetadata;
}

export interface RecordingStorageAdapter {
  upload(localPath: string, metadata: RecordingMetadata): Promise<UploadedRecording>;
  deleteLocal?(localPath: string): Promise<void>;
  onUploadError?(
    error: Error,
    localPath: string,
    metadata: RecordingMetadata,
  ): Promise<void>;
}
