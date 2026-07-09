/**
 * @module unicode
 *
 * Grapheme-aware string helpers built on `Intl.Segmenter`.
 *
 * JavaScript's `string.length` counts UTF-16 code units, so a single "family"
 * emoji (`👨‍👩‍👧‍👦`) reports length 11 and `.slice()` can tear the
 * ZWJ sequence. These helpers work on user-perceived characters (grapheme
 * clusters), which is the unit platform UIs actually render.
 *
 * Used by the WhatsApp formatter to avoid splitting surrogate pairs / emoji
 * / combining marks when applying its markdown→native regex rewrites.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Count user-perceived characters (graphemes) in a string. */
export function graphemeCount(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/**
 * Return a string containing the first `n` graphemes of `text`.
 *
 * `n` may exceed the actual grapheme count — the full string is returned in
 * that case. `n < 0` returns an empty string.
 */
export function sliceGraphemes(text: string, n: number): string {
  if (n <= 0) return '';
  let buf = '';
  let i = 0;
  for (const seg of segmenter.segment(text)) {
    if (i >= n) break;
    buf += seg.segment;
    i++;
  }
  return buf;
}

/** Break a string into an array of graphemes. */
export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const seg of segmenter.segment(text)) out.push(seg.segment);
  return out;
}
