import { parseJsonValue } from './decision-context';

export const QUOTE_EVIDENCE_VERSION = 'quote-evidence-v1' as const;
export const MAX_SOURCE_LENGTH = 100_000;
export const MAX_QUOTE_LENGTH = 10_000;
const MAX_MATCHES = 20;
const CONTEXT_LENGTH = 40;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Literal containment only: no web fetch, source authentication, or semantic entailment. */
export async function matchQuote(input: unknown) {
  let validated = false;
  try {
    const request = parseJsonValue(input, '$');
    if (!record(request) || request.version !== QUOTE_EVIDENCE_VERSION || !record(request.source)
      || Object.keys(request).some((key) => !['version', 'source', 'quote', 'expectedSourceHash'].includes(key))
      || Object.keys(request.source).some((key) => !['id', 'version', 'text'].includes(key))) throw new Error('Invalid request');
    const source = request.source;
    if (![source.id, source.version].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value)
      || typeof source.text !== 'string' || source.text.length === 0 || source.text.length > MAX_SOURCE_LENGTH || !wellFormed(source.text)
      || typeof request.quote !== 'string' || request.quote.length === 0 || request.quote.length > MAX_QUOTE_LENGTH || !wellFormed(request.quote)
      || (Object.hasOwn(request, 'expectedSourceHash') && (typeof request.expectedSourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedSourceHash)))) {
      throw new Error('Invalid request');
    }
    validated = true;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.text)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const identity = Object.freeze({ id: source.id, version: source.version, hash, hashAlgorithm: 'sha256-utf8' as const, origin: 'caller_supplied' as const });
    if (request.expectedSourceHash !== undefined && request.expectedSourceHash !== hash) {
      return Object.freeze({ status: 'source_mismatch' as const, version: QUOTE_EVIDENCE_VERSION, source: identity });
    }
    const matches: Array<{ readonly start: number; readonly end: number; readonly before: string; readonly after: string }> = [];
    let position = source.text.indexOf(request.quote), truncated = false;
    while (position !== -1) {
      if (matches.length === MAX_MATCHES) { truncated = true; break; }
      const end = position + request.quote.length;
      let contextStart = Math.max(0, position - CONTEXT_LENGTH), contextEnd = Math.min(source.text.length, end + CONTEXT_LENGTH);
      // Never cut a context excerpt in the middle of a surrogate pair.
      if (source.text.charCodeAt(contextStart) >= 0xdc00 && source.text.charCodeAt(contextStart) <= 0xdfff) contextStart++;
      if (source.text.charCodeAt(contextEnd) >= 0xdc00 && source.text.charCodeAt(contextEnd) <= 0xdfff) contextEnd--;
      matches.push(Object.freeze({ start: position, end, before: source.text.slice(contextStart, position), after: source.text.slice(end, contextEnd) }));
      position = source.text.indexOf(request.quote, position + 1);
    }
    return Object.freeze({ status: matches.length > 0 ? 'matched' as const : 'not_found' as const,
      version: QUOTE_EVIDENCE_VERSION, scope: 'literal_quote_in_supplied_text' as const, source: identity,
      quote: request.quote, offsets: 'utf16_code_units_end_exclusive' as const, matches: Object.freeze(matches), truncated,
      limitations: Object.freeze(['Literal presence does not prove truth, relevance, context, freshness, or source authenticity.']),
    });
  } catch {
    return Object.freeze({ status: 'error' as const, version: QUOTE_EVIDENCE_VERSION,
      error: Object.freeze({ code: validated ? 'EVIDENCE_FAILED' : 'INVALID_REQUEST' }) });
  }
}
