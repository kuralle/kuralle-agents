import { fileSessionEventLog } from '../../src/fileEventLog.js';
import type { StreamPart } from '@kuralle-agents/core';

const path = process.argv[2];
const mode = process.argv[3];
if (!path || !mode) process.exit(2);

const turnEnd = (): StreamPart => ({ channel: 'internal', type: 'turn-end', payload: {} });

const log = fileSessionEventLog(path);

if (mode === 'write-first') {
  await log.append('cross-sess', [turnEnd()], 'run-1');
} else if (mode === 'write-second') {
  await log.append('cross-sess', [turnEnd(), turnEnd()], 'run-2');
} else {
  process.exit(2);
}
