/**
 * @module whatsapp/templates
 *
 * Builder utilities for constructing WhatsApp template message payloads.
 *
 * Provides both a **typed builder** (structured config with type-safe
 * header/body/button definitions) and a **raw builder** (passthrough with
 * minimal normalization) for maximum flexibility.
 *
 * @example
 * ```ts
 * // Typed builder
 * const payload = buildTemplateSendPayload({
 *   name: 'order_confirmation',
 *   language: 'en_US',
 *   body: [
 *     { type: 'text', text: 'John' },
 *     { type: 'text', text: 'ORD-12345' },
 *   ],
 * });
 *
 * await client.sendTemplate(to, payload);
 * ```
 */

import type { OutboundTemplateComponent } from '@kuralle-agents/messaging';

import type {
  TemplateMessage,
  TemplateComponent,
  TemplateParameter,
  MediaObject,
} from './types.js';

/** Map channel-neutral template components to Meta {@link TemplateComponent} shape. */
export function mapOutboundTemplateComponents(
  components: OutboundTemplateComponent[] | undefined,
): TemplateComponent[] | undefined {
  if (!components?.length) return undefined;
  return components.map((c) => {
    const parameters: TemplateParameter[] | undefined = c.params?.map((text) => ({
      type: 'text' as const,
      text,
    }));
    return {
      type: c.type,
      sub_type: c.subType,
      index: c.index,
      parameters: parameters?.length ? parameters : undefined,
    };
  });
}

// ====================================
// TYPED BUILDER
// ====================================

/**
 * Typed configuration for building a template send payload.
 *
 * Provides a structured way to specify header, body, and button parameters
 * without manually constructing the `components` array.
 */
export interface TypedTemplateConfig {
  /** Template name (must match an approved template). */
  name: string;
  /** BCP 47 language code (e.g. `"en_US"`). */
  language: string;
  /** Header parameter — text or media. */
  header?:
    | { type: 'text'; text: string }
    | { type: 'image'; image: MediaObject }
    | { type: 'video'; video: MediaObject }
    | { type: 'document'; document: MediaObject };
  /** Body parameters (positional, matching `{{1}}`, `{{2}}`, etc.). */
  body?: TemplateParameter[];
  /** Button parameters (for dynamic URL suffixes or quick-reply payloads). */
  buttons?: Array<{
    /** Must be `"button"`. */
    type: 'button';
    /** Button sub-type (e.g. `"url"`, `"quick_reply"`). */
    subType: string;
    /** Zero-based button index. */
    index: number;
    /** Parameters for this button. */
    parameters: TemplateParameter[];
  }>;
}

/**
 * Build a template message payload from a typed configuration.
 *
 * Converts the structured {@link TypedTemplateConfig} into Meta's
 * `components` array format for the WhatsApp Cloud API.
 *
 * @param config - The typed template configuration.
 * @returns A {@link TemplateMessage} ready to send via the API.
 *
 * @example
 * ```ts
 * const payload = buildTemplateSendPayload({
 *   name: 'hello_world',
 *   language: 'en_US',
 *   header: { type: 'text', text: 'Welcome!' },
 *   body: [
 *     { type: 'text', text: 'John Doe' },
 *   ],
 *   buttons: [
 *     { type: 'button', subType: 'url', index: 0, parameters: [{ type: 'text', text: '/track/123' }] },
 *   ],
 * });
 * ```
 */
export function buildTemplateSendPayload(config: TypedTemplateConfig): TemplateMessage {
  const components: TemplateComponent[] = [];

  // Header component
  if (config.header) {
    const headerComponent: TemplateComponent = {
      type: 'header',
      parameters: [],
    };

    switch (config.header.type) {
      case 'text':
        headerComponent.parameters = [{ type: 'text', text: config.header.text }];
        break;
      case 'image':
        headerComponent.parameters = [{ type: 'image', image: config.header.image }];
        break;
      case 'video':
        headerComponent.parameters = [{ type: 'video', video: config.header.video }];
        break;
      case 'document':
        headerComponent.parameters = [{ type: 'document', document: config.header.document }];
        break;
    }

    components.push(headerComponent);
  }

  // Body component
  if (config.body && config.body.length > 0) {
    components.push({
      type: 'body',
      parameters: config.body,
    });
  }

  // Button components
  if (config.buttons) {
    for (const button of config.buttons) {
      components.push({
        type: 'button',
        sub_type: button.subType,
        index: button.index,
        parameters: button.parameters,
      });
    }
  }

  return {
    name: config.name,
    language: { code: config.language },
    components: components.length > 0 ? components : undefined,
  };
}

// ====================================
// RAW BUILDER
// ====================================

/**
 * Raw template components configuration.
 *
 * A minimal wrapper around Meta's native `components` format for cases
 * where the caller wants full control over the payload structure.
 */
export interface RawTemplateComponents {
  /** Template name. */
  name: string;
  /** Language specification. */
  language: { code: string; policy?: string };
  /** Raw components array in Meta's format. */
  components: TemplateComponent[];
}

/**
 * Build a template message payload from raw components.
 *
 * This is a passthrough builder that accepts Meta's native format directly,
 * performing only minimal validation. Use this when you need full control
 * over the payload or when the typed builder does not cover a specific case.
 *
 * @param config - The raw template configuration.
 * @returns A {@link TemplateMessage} ready to send via the API.
 *
 * @example
 * ```ts
 * const payload = buildTemplatePayload({
 *   name: 'custom_template',
 *   language: { code: 'en' },
 *   components: [
 *     { type: 'body', parameters: [{ type: 'text', text: 'Hello' }] },
 *   ],
 * });
 * ```
 */
export function buildTemplatePayload(config: RawTemplateComponents): TemplateMessage {
  return {
    name: config.name,
    language: config.language,
    components: config.components,
  };
}
