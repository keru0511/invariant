/** Stable UTF-16 code-unit order, independent of host language and ICU data. */
export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
