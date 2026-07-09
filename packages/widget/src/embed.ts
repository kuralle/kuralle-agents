/**
 * Kuralle Widget - Embed Script
 *
 * This file registers the widget as a Web Component and auto-initializes
 * any <kuralle-widget> elements on the page.
 */

import register from 'preact-custom-element';
import { Widget, type WidgetProps } from './widget/Widget';
import './widget/styles.css';
import { debug } from './debug.js';

const observedAttributes = [
  'agent-url',
  'agent-id',
  // Legacy support
  'widget-id',
  'api-url',
  // Other options
  'mode',
  'theme',
  'position',
  'size',
  'radius',
  'base-color',
  'accent-color',
  'button-base-color',
  'button-accent-color',
  'title',
  'subtitle',
  'empty-chat-message',
];

// Register the custom element
register(
  Widget,
  'kuralle-widget',
  // Keep kebab-case attribute names for HTML usage.
  observedAttributes as (keyof WidgetProps)[],
  // Shadow DOM (optional, set to false for light DOM)
  { shadow: false }
);

// Auto-initialize widgets when DOM is ready
if (typeof document !== 'undefined') {
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidgets);
  } else {
    initWidgets();
  }
}

function initWidgets() {
  // Find all <kuralle-widget> elements and log initialization
  const widgets = document.querySelectorAll('kuralle-widget');
  debug(`[Kuralle] Initializing ${widgets.length} widget(s)`);

  // The preact-custom-element register() handles the actual rendering
  // We just need to ensure the elements are in the DOM
}

// Export for programmatic use
export { Widget, type WidgetProps };
export type { AgentConfig, Message } from './client/WidgetClient';
export { WidgetClient } from './client/WidgetClient';
