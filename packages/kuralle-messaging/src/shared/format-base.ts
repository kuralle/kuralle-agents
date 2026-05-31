/**
 * @module shared/format-base
 *
 * Text-formatting contract for platform clients.
 *
 * Historically this file exported a `BaseFormatConverter` abstract class whose
 * three methods were all pass-through no-ops; subclasses were forced to
 * `extends BaseFormatConverter` purely to satisfy the `FormatConverter`
 * interface. That added no information hiding and no reuse. It's been
 * replaced with two plain interfaces and a small `passthroughFormatter` helper
 * callers can compose when they want the old behavior.
 */

/**
 * Minimal 1-method formatter — enough for the one call site that actually
 * matters (streaming LLM output to a platform). Platform clients that only
 * need outbound formatting can implement this interface and skip the other
 * two methods entirely.
 */
export interface MessageFormatter {
  /** Convert Markdown LLM output into the platform's native text format. */
  toPlatformFormat(markdown: string): string;
}

/**
 * Pass-through formatter equivalent to the old `BaseFormatConverter`
 * defaults. Useful as a trivial stub in tests or starter code.
 */
export const passthroughFormatter: MessageFormatter = {
  toPlatformFormat: (markdown) => markdown,
};
