import { maxSatisfying, valid, validRange } from 'semver';
import { DeploymentError } from './errors.js';

export interface VersionedValue<T> {
  id: string;
  version: string;
  value: T;
}

/** A write-once registry for executable capabilities shipped by one runtime revision. */
export class VersionedRegistry<T> {
  private readonly entries = new Map<string, Map<string, T>>();

  register(entry: VersionedValue<T>): void {
    if (!valid(entry.version)) {
      throw new DeploymentError('BINDING_FAILED', `invalid version ${entry.version} for ${entry.id}`);
    }
    const versions = this.entries.get(entry.id) ?? new Map<string, T>();
    if (versions.has(entry.version)) {
      throw new DeploymentError(
        'CONFLICT',
        `capability ${entry.id}@${entry.version} is already registered`,
      );
    }
    versions.set(entry.version, entry.value);
    this.entries.set(entry.id, versions);
  }

  resolve(id: string, range: string): T {
    if (!validRange(range)) {
      throw new DeploymentError('BINDING_FAILED', `invalid version range ${range} for ${id}`);
    }
    const versions = this.entries.get(id);
    const selected = versions ? maxSatisfying([...versions.keys()], range) : null;
    if (!versions || !selected) {
      throw new DeploymentError('BINDING_FAILED', `no registered ${id} satisfies ${range}`);
    }
    return versions.get(selected)!;
  }

  manifest(): Array<{ id: string; version: string }> {
    return [...this.entries.entries()]
      .flatMap(([id, versions]) => [...versions.keys()].map(version => ({ id, version })))
      .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
  }
}

export class NamedRegistry<T> {
  private readonly entries = new Map<string, T>();

  register(id: string, value: T): void {
    if (this.entries.has(id)) {
      throw new DeploymentError('CONFLICT', `${id} is already registered`);
    }
    this.entries.set(id, value);
  }

  resolve(id: string): T {
    const value = this.entries.get(id);
    if (value === undefined) {
      throw new DeploymentError('BINDING_FAILED', `${id} is not registered`);
    }
    return value;
  }
}
