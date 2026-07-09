import type { Session, WorkingMemory } from '../types/index.js';

export class SessionWorkingMemory implements WorkingMemory {
  constructor(private session: Session) {}

  get<T>(key: string): T | undefined {
    return this.session.workingMemory[key] as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.session.workingMemory[key] = value as unknown;
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.session.workingMemory, key);
  }

  delete(key: string): boolean {
    if (this.has(key)) {
      delete this.session.workingMemory[key];
      return true;
    }
    return false;
  }

  clear(): void {
    this.session.workingMemory = {};
  }

  toJSON(): Record<string, unknown> {
    return { ...this.session.workingMemory };
  }
}
