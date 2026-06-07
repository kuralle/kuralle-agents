/**
 * HTTP Tool Factory
 *
 * Creates ToolDefinition instances from HTTP configuration.
 * Enables declarative API integration without writing code.
 */

import { z } from 'zod';
import { createTool } from './Tool.js';
import type { Tool, ToolExecutionOptions } from './Tool.js';
import type {
  HttpToolConfig,
  HttpParam,
  ParamType,
  AuthConfig,
  HttpToolResult,
} from './http.types.js';
import { getUserFriendlyError } from './errorMessages.js';

/**
 * Create a tool that makes HTTP requests based on config.
 * The tool will substitute path params, build query/body, and execute the request.
 */
export function createHttpTool(config: HttpToolConfig): Tool<unknown, HttpToolResult> {
  const {
    description,
    method,
    url,
    pathParams = [],
    queryParams = [],
    headers = {},
    bodyParams = [],
    auth,
    timeoutMs = 30000,
    errorMessages,
  } = config;

  // Build Zod schema from all parameters
  const inputSchema = buildInputSchema([...pathParams, ...queryParams, ...bodyParams]);

  return createTool({
    description,
    inputSchema,
    execute: async (input: unknown, options?: ToolExecutionOptions) => {
      const validatedInput = input as Record<string, unknown>;
      const idempotencyKey = getIdempotencyKey(options);
      try {
        const result = await executeHttpRequest(
          method,
          url,
          validatedInput,
          pathParams,
          queryParams,
          headers,
          bodyParams,
          auth,
          timeoutMs,
          idempotencyKey
        );

        return result;
      } catch (error) {
        const errorMsg = getUserFriendlyError(error as Error, errorMessages);
        return {
          success: false,
          error: errorMsg,
        };
      }
    },
  });
}

/** Build Zod schema from HTTP params */
function buildInputSchema(params: HttpParam[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const param of params) {
    let zodType: z.ZodTypeAny = getZodType(param.type);

    if (param.description) {
      zodType = zodType.describe(param.description);
    }

    if (!param.required) {
      zodType = zodType.optional();
    }

    shape[param.name] = zodType;
  }

  return z.object(shape);
}

/** Map param type to Zod type */
function getZodType(type: ParamType): z.ZodTypeAny {
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'object':
      return z.record(z.string(), z.unknown());
    case 'array':
      return z.array(z.unknown());
    default:
      return z.unknown();
  }
}

/** Execute the HTTP request */
async function executeHttpRequest(
  method: string,
  url: string,
  input: Record<string, unknown>,
  pathParams: HttpParam[],
  queryParams: HttpParam[],
  headers: Record<string, string>,
  bodyParams: HttpParam[],
  auth: AuthConfig | undefined,
  timeoutMs: number,
  idempotencyKey?: string
): Promise<HttpToolResult> {
  // 1. Basic URL validation
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return {
      success: false,
      error: 'Invalid URL: Must start with http:// or https://',
    };
  }

  // 2. Substitute path params using regex for robustness
  let substitutedUrl = url;
  substitutedUrl = substitutedUrl.replace(/\{(\w+)\}/g, (match, paramName) => {
    const value = input[paramName];
    if (value !== undefined && value !== null) {
      return encodeURIComponent(String(value));
    }
    return match; // Keep as is if not provided
  });

  let urlObj: URL;
  try {
    urlObj = new URL(substitutedUrl);
  } catch (err) {
    return {
      success: false,
      error: `Malformed URL after substitution: ${substitutedUrl}`,
    };
  }

  // 3. Build query string (merging with existing)
  for (const param of queryParams) {
    const value = input[param.name];
    if (value !== undefined && value !== null) {
      urlObj.searchParams.append(param.name, String(value));
    }
  }

  const finalUrl = urlObj.toString();

  // 4. Build headers with auth
  const finalHeaders: Record<string, string> = { ...headers, 'Content-Type': 'application/json' };
  if (auth) {
    addAuthHeaders(finalHeaders, auth, input);
  }
  // For side-effecting requests, forward runtime-generated idempotency key by default.
  if (idempotencyKey && method !== 'GET' && !hasHeader(finalHeaders, 'Idempotency-Key')) {
    finalHeaders['Idempotency-Key'] = idempotencyKey;
  }

  // 5. Build body
  let body: string | undefined;
  if (['POST', 'PUT', 'PATCH'].includes(method) && bodyParams.length > 0) {
    const bodyObj: Record<string, unknown> = {};
    for (const param of bodyParams) {
      const value = input[param.name];
      if (value !== undefined) {
        bodyObj[param.name] = value;
      }
    }
    body = JSON.stringify(bodyObj);
  }

  // 6. Execute with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(finalUrl, {
      method,
      headers: finalHeaders,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseData = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        error: (responseData as { message?: string })?.message || response.statusText || 'Request failed',
        data: responseData,
      };
    }

    return {
      success: true,
      status: response.status,
      data: responseData,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if ((error as Error).name === 'AbortError') {
      return {
        success: false,
        error: `Request timeout after ${timeoutMs}ms`,
      };
    }

    throw error;
  }
}

function hasHeader(headers: Record<string, string>, target: string): boolean {
  const targetLower = target.toLowerCase();
  return Object.keys(headers).some(name => name.toLowerCase() === targetLower);
}

function getIdempotencyKey(options: unknown): string | undefined {
  if (!isRecord(options)) return undefined;
  const context = options.experimental_context;
  if (!isRecord(context)) return undefined;
  const key = context.idempotencyKey;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Add authentication headers */
function addAuthHeaders(
  headers: Record<string, string>,
  auth: AuthConfig,
  input: Record<string, unknown>
): void {
  switch (auth.type) {
    case 'bearer':
      if (auth.token) {
        const token = expandEnvVar(auth.token);
        headers['Authorization'] = `Bearer ${token}`;
      }
      break;
    case 'basic':
      if (auth.username && auth.password) {
        const creds = `${expandEnvVar(auth.username)}:${expandEnvVar(auth.password)}`;
        headers['Authorization'] = `Basic ${btoa(creds)}`;
      }
      break;
    case 'custom':
      if (auth.headers) {
        for (const [key, value] of Object.entries(auth.headers)) {
          headers[key] = expandEnvVar(value);
        }
      }
      break;
  }
}

/** Expand environment variables like ${VAR_NAME} */
function expandEnvVar(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || '';
  });
}
