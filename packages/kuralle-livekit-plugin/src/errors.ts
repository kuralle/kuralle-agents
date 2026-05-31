export class TransportError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export class TransportDisconnectedError extends TransportError {
  constructor(message: string = 'Transport connection closed', cause?: Error) {
    super(message, cause);
    this.name = 'TransportDisconnectedError';
  }
}

export class TransportProtocolError extends TransportError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'TransportProtocolError';
  }
}

export class AudioConfigError extends TransportError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'AudioConfigError';
  }
}
