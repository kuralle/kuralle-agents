export interface ParsedFlagArgs {
  positional: string[];
  flags: Map<string, string>;
}

/** Parse `--key value` and `--key=value` flags from a slash-command tail. */
export function parseFlagArgs(input: string): ParsedFlagArgs {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(body, next);
      index += 1;
    } else {
      flags.set(body, 'true');
    }
  }

  return { positional, flags };
}
