import { turnResultJsonSchema } from './turnResult.js';

export function runSchema(): void {
  process.stdout.write(`${JSON.stringify(turnResultJsonSchema)}\n`);
}
