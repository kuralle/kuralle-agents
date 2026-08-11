import type { Diagnostic, PluginAuthor, PluginManifest, Rejection } from './types.js';
import { diagnostic as makeDiagnostic, isPlainObject } from './diagnostics.js';

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

const OPTIONAL_STRING_FIELDS = [
  'version',
  'description',
  'homepage',
  'repository',
  'license',
] as const;

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

function diagnostic(section: string, rule: string, message: string): Diagnostic {
  return makeDiagnostic(section, rule, MANIFEST_ORIGIN, message);
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

/**
 * A validator yields the narrowed value it proved, or the rejection explaining why it
 * could not. Returning only the rejection is what forced a second pass to re-derive every
 * field by casting — and a cast asserts a fact the compiler cannot check, which is exactly
 * how `validateCommand` came to resolve a path and throw it away.
 *
 * The failure arm is `ManifestValidationFailure` itself, so any validator's rejection
 * returns straight out of `validateManifestJson` with no rewrapping.
 */
type Validated<T> = { ok: true; value: T } | ManifestValidationFailure;

function valid<T>(value: T): Validated<T> {
  return { ok: true, value };
}

function validateName(name: unknown): Validated<string> {
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

  return valid(name);
}

function validateSchemaField(schema: unknown): Validated<string> {
  if (typeof schema !== 'string' || schema.length === 0) {
    return reject(
      '5.3',
      'required-field-missing',
      'Required field "$schema" is missing, has the wrong type, or is empty.',
    );
  }

  if (schema === SUPPORTED_SCHEMA) {
    return valid(schema);
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

function validateAuthor(author: unknown): Validated<PluginAuthor | undefined> {
  if (author === undefined) {
    return valid(undefined);
  }

  if (!isPlainObject(author)) {
    return reject(
      '5.4',
      'author-unknown-field',
      'The "author" field must be an object.',
    );
  }

  const result: PluginAuthor = {};

  for (const [key, value] of Object.entries(author)) {
    if (key !== 'name' && key !== 'email' && key !== 'url') {
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
    result[key] = value;
  }

  // §5.4 makes all three author fields optional, so `{}` is a valid author object — it
  // just names nobody. Reported as absent rather than as an empty object, so a consumer
  // that tests `manifest.author` never has to re-test it for emptiness.
  return valid(Object.keys(result).length > 0 ? result : undefined);
}

function validateOptionalStringField(
  field: string,
  value: unknown,
): Validated<string | undefined> {
  if (value === undefined) {
    return valid(undefined);
  }
  if (typeof value !== 'string') {
    return reject(
      '5.2',
      'invalid-field-type',
      `Field "${field}" must be a string.`,
    );
  }
  return valid(value);
}

function validateKeywords(keywords: unknown): Validated<string[] | undefined> {
  if (keywords === undefined) {
    return valid(undefined);
  }
  if (!Array.isArray(keywords)) {
    return reject(
      '5.2',
      'invalid-field-type',
      'Field "keywords" must be an array of strings.',
    );
  }
  const result: string[] = [];
  for (const item of keywords) {
    if (typeof item !== 'string') {
      return reject(
        '5.2',
        'invalid-field-type',
        'Field "keywords" must be an array of strings.',
      );
    }
    result.push(item);
  }
  return valid(result);
}

/**
 * §8.1: `extensions` maps a client namespace to an object. §5.2 and §11.3 make a
 * violation non-fatal, so this reports and drops rather than rejecting — a client
 * namespace nobody here understands must never stop the plugin loading.
 *
 * Member values are checked rather than asserted. The old cast claimed every member was
 * an object on no evidence, which would have handed a consumer a number typed as a record.
 */
function validateExtensions(value: unknown): {
  extensions: Record<string, Record<string, unknown>> | undefined;
  diagnostics: Diagnostic[];
} {
  if (value === undefined) {
    return { extensions: undefined, diagnostics: [] };
  }

  if (!isPlainObject(value)) {
    return {
      extensions: undefined,
      diagnostics: [
        diagnostic(
          '8.1',
          'extensions-not-an-object',
          'The "extensions" field must be an object.',
        ),
      ],
    };
  }

  const extensions: Record<string, Record<string, unknown>> = {};
  const diagnostics: Diagnostic[] = [];

  for (const [namespace, data] of Object.entries(value)) {
    if (!isPlainObject(data)) {
      diagnostics.push(
        diagnostic(
          '8.1',
          'extensions-not-an-object',
          `Extension namespace "${namespace}" must map to an object.`,
        ),
      );
      continue;
    }
    extensions[namespace] = data;
  }

  return { extensions, diagnostics };
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

  const schema = validateSchemaField(raw.$schema);
  if (!schema.ok) {
    return schema;
  }

  const name = validateName(raw.name);
  if (!name.ok) {
    return name;
  }

  const author = validateAuthor(raw.author);
  if (!author.ok) {
    return author;
  }

  const manifest: PluginManifest = { $schema: schema.value, name: name.value };

  for (const field of OPTIONAL_STRING_FIELDS) {
    const result = validateOptionalStringField(field, raw[field]);
    if (!result.ok) {
      return result;
    }
    if (result.value !== undefined) {
      manifest[field] = result.value;
    }
  }

  const keywords = validateKeywords(raw.keywords);
  if (!keywords.ok) {
    return keywords;
  }

  if (author.value !== undefined) {
    manifest.author = author.value;
  }
  if (keywords.value !== undefined) {
    manifest.keywords = keywords.value;
  }

  const extensions = validateExtensions(raw.extensions);
  diagnostics.push(...extensions.diagnostics);
  if (extensions.extensions !== undefined) {
    manifest.extensions = extensions.extensions;
  }

  return { ok: true, manifest, diagnostics };
}
