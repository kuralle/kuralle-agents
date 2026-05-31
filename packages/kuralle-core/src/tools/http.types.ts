/**
 * HTTP Tool Types
 *
 * Declarative HTTP-based tools inspired by ElevenLabs server tools.
 * Enables agents to connect to external APIs via configuration.
 */

/** HTTP methods supported */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Parameter types for HTTP tools */
export type ParamType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/** HTTP parameter definition */
export interface HttpParam {
  name: string;
  type: ParamType;
  description: string;
  required?: boolean;
  default?: unknown;
}

/** Authentication configuration */
export interface AuthConfig {
  type: 'bearer' | 'basic' | 'custom';
  token?: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
}

/** HTTP tool configuration */
export interface HttpToolConfig {
  /** Tool name (used as function name by LLM) */
  name: string;
  /** Description helps LLM understand when to use this tool */
  description: string;
  /** HTTP method */
  method: HttpMethod;
  /** URL with optional path params like {id} */
  url: string;
  /** Path parameters (substituted in URL) */
  pathParams?: HttpParam[];
  /** Query parameters (appended to URL) */
  queryParams?: HttpParam[];
  /** Request headers */
  headers?: Record<string, string>;
  /** Body parameters (for POST/PUT/PATCH) */
  bodyParams?: HttpParam[];
  /** Authentication config */
  auth?: AuthConfig;
  /** Request timeout in ms */
  timeoutMs?: number;
  /** Custom error messages */
  errorMessages?: Record<string, string>;
}

/** HTTP tool execution result */
export interface HttpToolResult {
  success: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  headers?: Record<string, string>;
}
