export type DeploymentErrorCode =
  | 'ARTIFACT_INVALID'
  | 'ARTIFACT_DIGEST_MISMATCH'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'RELEASE_INVALID';

export class DeploymentError extends Error {
  constructor(
    readonly code: DeploymentErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'DeploymentError';
  }
}
