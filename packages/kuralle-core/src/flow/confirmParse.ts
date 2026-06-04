export type ConfirmVerdict = 'affirm' | 'decline' | 'ambiguous';

const AFFIRM_TOKENS = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'ya',
  'sure',
  'ok',
  'okay',
  'okey',
  'k',
  'confirm',
  'confirmed',
  'correct',
  'right',
  'proceed',
  'do',
  'done',
  'yessir',
  'affirmative',
  'ow',
  'ova',
  'hari',
  'hariyata',
  'ehenam',
  'aam',
  'aama',
  'sari',
  'seri',
]);

const AFFIRM_PHRASES = [
  'go ahead',
  'do it',
  'book it',
  'place it',
  'place the order',
  'place my order',
  'sounds good',
  "that's right",
  'thats right',
  'that is correct',
  'please do',
  "let's do it",
  'lets do it',
  'go for it',
  'confirm the order',
  'yes please',
];

const AFFIRM_SCRIPT = ['ඔව්', 'හරි', 'හා', 'හරියට', 'ஆம்', 'சரி', 'ஆமா'];

const DECLINE_TOKENS = new Set([
  'no',
  'nope',
  'nah',
  'na',
  'not',
  'dont',
  "don't",
  'stop',
  'cancel',
  'wait',
  'hold',
  'change',
  'edit',
  'incorrect',
  'wrong',
  'nevermind',
  'never',
  'naha',
  'nae',
  'epa',
  'epaa',
  'wenas',
  'illa',
  'illai',
  'vendam',
  'vendaam',
  'vena',
]);

const DECLINE_PHRASES = [
  'not yet',
  'hold on',
  'no thanks',
  'no thank you',
  "don't",
  'do not',
  'change it',
  'change the',
  'let me change',
  'something else',
  'go back',
];

const DECLINE_SCRIPT = ['නැහැ', 'නෑ', 'එපා', 'වෙනස්', 'இல்லை', 'வேண்டாம்', 'வேற'];

const INTERROGATIVE_WORDS = [
  'what',
  'how',
  'when',
  'where',
  'why',
  'which',
  'who',
  'do you',
  'can you',
  'could you',
  'is there',
  'tell me',
  'show me',
];

function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function stripTokenPunctuation(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function tokenize(normalized: string): string[] {
  return normalized
    .split(/\s+/)
    .map(stripTokenPunctuation)
    .filter((token) => token.length > 0);
}

function hasDeclineToken(tokens: string[]): boolean {
  return tokens.some((token) => DECLINE_TOKENS.has(token));
}

function hasDeclinePhrase(normalized: string): boolean {
  return DECLINE_PHRASES.some((phrase) => normalized.includes(phrase));
}

function hasDeclineScript(normalized: string, raw: string): boolean {
  return DECLINE_SCRIPT.some((fragment) => normalized.includes(fragment) || raw.includes(fragment));
}

function hasDecline(normalized: string, tokens: string[], raw: string): boolean {
  return hasDeclineToken(tokens) || hasDeclinePhrase(normalized) || hasDeclineScript(normalized, raw);
}

function hasInterrogative(normalized: string): boolean {
  if (normalized.includes('?')) {
    return true;
  }
  return INTERROGATIVE_WORDS.some((word) => {
    const pattern = new RegExp(`(?:^|\\s)${word.replace(/\s+/g, '\\s+')}(?:\\s|$|[?.!,])`, 'i');
    return pattern.test(normalized);
  });
}

function hasAffirmScript(normalized: string, raw: string): boolean {
  return AFFIRM_SCRIPT.some((fragment) => normalized.includes(fragment) || raw.includes(fragment));
}

function hasAffirmPhrase(normalized: string): boolean {
  return AFFIRM_PHRASES.some((phrase) => normalized.startsWith(phrase));
}

function hasAffirmToken(tokens: string[]): boolean {
  const head = tokens.slice(0, 3);
  if (head.some((token) => AFFIRM_TOKENS.has(token))) {
    return true;
  }
  return tokens.length === 1 && tokens[0] === 'y';
}

function hasAffirm(normalized: string, tokens: string[], raw: string): boolean {
  return hasAffirmScript(normalized, raw) || hasAffirmPhrase(normalized) || hasAffirmToken(tokens);
}

export function parseConfirmation(raw: string): ConfirmVerdict {
  const normalized = normalize(raw);
  const tokens = tokenize(normalized);

  if (hasDecline(normalized, tokens, raw)) {
    return 'decline';
  }
  if (hasInterrogative(normalized)) {
    return 'ambiguous';
  }
  if (hasAffirm(normalized, tokens, raw)) {
    return 'affirm';
  }
  return 'ambiguous';
}
