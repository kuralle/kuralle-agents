import type { Diagnostic, PluginAuthor, PluginManifest, Rejection } from './types.js';

const MANIFEST_ORIGIN = 'plugin.json';

const SUPPORTED_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

const PERMITTED_TOP_LEVEL = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

const AUTHOR_KEYS = new Set(['name', 'email', 'url']);

const AGENT_PLUGINS_SCHEMA_PATTERN =
  /^https:\/\/agent-plugins\.org\/schemas\/[^/]+\/plugin\.schema\.json$/;

export interface ManifestValidationSuccess {
  ok: true;
  manifest: PluginManifest;
  diagnostics: Diagnostic[];
}

export interface ManifestValidationFailure {
  ok: false;
  rejection: Rejection;
  diagnostics: Diagnostic[];
}

export type ManifestValidationResult =
  | ManifestValidationSuccess
  | ManifestValidationFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(
  section: string,
  rule: string,
  message: string,
): Diagnostic {
  return { section, rule, origin: MANIFEST_ORIGIN, message };
}

function reject(
  section: string,
  rule: string,
  message: string,
): ManifestValidationFailure {
  return {
    ok: false,
    rejection: { section, rule, message },
    diagnostics: [diagnostic(section, rule, message)],
  };
}

function validateName(name: unknown): ManifestValidationFailure | null {
  if (typeof name !== 'string' || name.length === 0) {
    return reject(
      '5.3',
      'required-field-missing',
      'Required field "name" is missing, has the wrong type, or is empty.',
    );
  }

  if (!/^[a-z0-9.-]+$/.test(name)) {
    return reject(
      '5.5',
      'name-charset',
      `Plugin name "${name}" contains characters outside the permitted set.`,
    );
  }

  if (name.length > 64) {
    return reject(
      '5.5',
      'name-charset',
      `Plugin name "${name}" exceeds the maximum length of 64 characters.`,
    );
  }

  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) {
    return reject(
      '5.5',
      'name-boundary',
      `Plugin name "${name}" must start and end with an alphanumeric character.`,
    );
  }

  if (name.includes('--') || name.includes('..')) {
    return reject(
      '5.5',
      'name-repetition',
      `Plugin name "${name}" must not contain consecutive hyphens or periods.`,
    );
  }

  return null;
}

function validateSchemaField(
  schema: unknown,
): ManifestValidationFailure | null {
  if (typeof schema !== 'string' || schema.length === 0) {
    return reject(
      '5.3',
      'required-field-missing',
      'Required field "$schema" is missing, has the wrong type, or is empty.',
    );
  }

  if (schema === SUPPORTED_SCHEMA) {
    return null;
  }

  if (AGENT_PLUGINS_SCHEMA_PATTERN.test(schema)) {
    return reject(
      '5.2',
      'unsupported-schema-version',
      `Unsupported Agent Plugins schema version: ${schema}`,
    );
  }

  return reject(
    '5.2',
    'unsupported-schema-version',
    `Unrecognized Agent Plugins schema identifier: ${schema}`,
  );
}

function validateAuthor(author: unknown): ManifestValidationFailure | null {
  if (author === undefined) {
    return null;
  }

  if (!isPlainObject(author)) {
    return reject(
      '5.4',
      'author-unknown-field',
      'The "author" field must be an object.',
    );
  }

  for (const [key, value] of Object.entries(author)) {
    if (!AUTHOR_KEYS.has(key)) {
      return reject(
        '5.4',
        'author-unknown-field',
        `Unknown author field "${key}".`,
      );
    }
    if (typeof value !== 'string') {
      return reject(
        '5.4',
        'author-unknown-field',
        `Author field "${key}" must be a string.`,
      );
    }
  }

  return null;
}

function validateOptionalStringField(
  field: string,
  value: unknown,
): ManifestValidationFailure | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return reject(
      '5.2',
      'invalid-field-type',
      `Field "${field}" must be a string.`,
    );
  }
  return null;
}

function validateKeywords(
  keywords: unknown,
): ManifestValidationFailure | null {
  if (keywords === undefined) {
    return null;
  }
  if (!Array.isArray(keywords)) {
    return reject(
      '5.2',
      'invalid-field-type',
      'Field "keywords" must be an array of strings.',
    );
  }
  for (const item of keywords) {
    if (typeof item !== 'string') {
      return reject(
        '5.2',
        'invalid-field-type',
        'Field "keywords" must be an array of strings.',
      );
    }
  }
  return null;
}

function buildAuthor(raw: Record<string, unknown>): PluginAuthor | undefined {
  const author: PluginAuthor = {};
  if (typeof raw.name === 'string') author.name = raw.name;
  if (typeof raw.email === 'string') author.email = raw.email;
  if (typeof raw.url === 'string') author.url = raw.url;
  return Object.keys(author).length > 0 ? author : undefined;
}

function buildManifest(raw: Record<string, unknown>): PluginManifest {
  const manifest: PluginManifest = {
    $schema: raw.$schema as string,
    name: raw.name as string,
  };

  if (typeof raw.version === 'string') manifest.version = raw.version;
  if (typeof raw.description === 'string') manifest.description = raw.description;
  if (isPlainObject(raw.author)) manifest.author = buildAuthor(raw.author);
  if (typeof raw.homepage === 'string') manifest.homepage = raw.homepage;
  if (typeof raw.repository === 'string') manifest.repository = raw.repository;
  if (typeof raw.license === 'string') manifest.license = raw.license;
  if (Array.isArray(raw.keywords)) {
    manifest.keywords = raw.keywords.filter(
      (item): item is string => typeof item === 'string',
    );
  }
  if (isPlainObject(raw.extensions)) {
    manifest.extensions = raw.extensions as Record<
      string,
      Record<string, unknown>
    >;
  }

  return manifest;
}

export function validateManifestJson(text: string): ManifestValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reject(
      '5.2',
      'invalid-json',
      'plugin.json is not valid JSON.',
    );
  }

  if (!isPlainObject(parsed)) {
    return reject(
      '5.2',
      'manifest-not-an-object',
      'plugin.json must contain a top-level object.',
    );
  }

  const diagnostics: Diagnostic[] = [];
  const raw: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (!PERMITTED_TOP_LEVEL.has(key)) {
      diagnostics.push(
        diagnostic(
          '5.2',
          'unknown-top-level-field',
          `Unknown top-level field "${key}".`,
        ),
      );
      continue;
    }
    raw[key] = value;
  }

  if ('extensions' in raw && !isPlainObject(raw.extensions)) {
    diagnostics.push(
      diagnostic(
        '8.1',
        'extensions-not-an-object',
        'The "extensions" field must be an object.',
      ),
    );
    delete raw.extensions;
  }

  const schemaFailure = validateSchemaField(raw.$schema);
  if (schemaFailure) {
    return schemaFailure;
  }

  const nameFailure = validateName(raw.name);
  if (nameFailure) {
    return nameFailure;
  }

  const authorFailure = validateAuthor(raw.author);
  if (authorFailure) {
    return authorFailure;
  }

  for (const field of [
    'version',
    'description',
    'homepage',
    'repository',
    'license',
  ] as const) {
    const failure = validateOptionalStringField(field, raw[field]);
    if (failure) {
      return failure;
    }
  }

  const keywordsFailure = validateKeywords(raw.keywords);
  if (keywordsFailure) {
    return keywordsFailure;
  }

  return {
    ok: true,
    manifest: buildManifest(raw),
    diagnostics,
  };
}
