/** Every launch flag kuralle-tui accepts — kept in one place so help text and tests stay aligned. */
export const CLI_USAGE_FLAGS = [
  ['--local', 'Load a local agent from the path that follows (same as a filesystem positional)'],
  ['--server', 'Hosted server URL (alternative to the positional argument)'],
  ['--transport', 'Override transport inference: http, cloudflare, or local'],
  ['--agent-name', 'Agent name on a hosted or Cloudflare deployment'],
  ['--session', 'Attach to an existing session id'],
  ['--user', 'Memory owner id for the session'],
  ['--token-env', 'Environment variable holding the auth token (default: KURALLE_TOKEN)'],
  ['--model', 'Model id when the local agent export has no model'],
  ['--env-file', 'Load environment variables from this file instead of ./.env'],
] as const;

export function wantsCliUsage(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

export function formatCliUsage(): string {
  const optionLines = CLI_USAGE_FLAGS.map(([flag, description]) => `  ${flag.padEnd(20)} ${description}`);
  return [
    'kuralle-tui — OpenTUI chat surface for Kuralle sessions',
    '',
    'Requires Bun >= 1.3. Node is not a supported runtime for this binary.',
    '',
    'Usage:',
    '  kuralle-tui [server|path] [options]',
    '',
    'Arguments:',
    '  server|path           Hosted URL or local agent path (transport inferred from scheme)',
    '',
    'Options:',
    ...optionLines,
    '  --help, -h            Print this message and exit',
    '',
  ].join('\n');
}

export function printCliUsage(): void {
  process.stdout.write(formatCliUsage());
}
