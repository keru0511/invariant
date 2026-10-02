import { expect, it, vi } from 'vitest';
import { matchQuote } from './quote-evidence';
const request = (text: string, quote: string) => ({ version: 'quote-evidence-v1', source: { id: 'synthetic-source', version: 'v1', text }, quote });
it('finds exact literal quotes and exposes the limited scope', async () => {
  expect(await matchQuote(request('前提：料金は未確定。', '料金は未確定'))).toMatchObject({
    status: 'matched', scope: 'literal_quote_in_supplied_text', matches: [{ start: 3, end: 9 }], source: { origin: 'caller_supplied' },
  });
});
it.each([['料金は未確定。', '料金は確定。'], ['Ａ', 'A'], ['Alpha', 'alpha'], ['a\r\nb', 'a\nb']])('does not invent or normalize a quote (%s)', async (text, quote) => {
  expect((await matchQuote(request(text, quote))).status).toBe('not_found');
});
it('preserves Unicode and uses explicit UTF-16 offsets', async () => {
  expect(await matchQuote(request('😀根拠', '根拠'))).toMatchObject({ matches: [{ start: 2, end: 4 }], offsets: 'utf16_code_units_end_exclusive' });
});
it('binds the supplied text to a standard UTF-8 SHA-256 and rejects a changed source', async () => {
  const known = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  expect(await matchQuote({ ...request('abc', 'b'), expectedSourceHash: known })).toMatchObject({ status: 'matched', source: { hash: known } });
  expect((await matchQuote({ ...request('abcd', 'b'), expectedSourceHash: known })).status).toBe('source_mismatch');
});
it.each([request('abc', ''), request('abc', '\ud800'), request('\udfff', 'a'), request('x'.repeat(100001), 'x')])('rejects empty, oversized, or malformed Unicode input', async (input) => {
  expect((await matchQuote(input)).status).toBe('error');
});
it('bounds repeated matches and snapshots before hashing', async () => {
  const input = request('a'.repeat(30), 'a');
  const pending = matchQuote(input); input.source.text = 'changed'; input.quote = 'different';
  const result = await pending;
  expect(result).toMatchObject({ status: 'matched', truncated: true, quote: 'a' });
  if ('matches' in result) { expect(result.matches).toHaveLength(20); expect(Object.isFrozen(result.matches)).toBe(true); }
  expect(Object.isFrozen(input)).toBe(false);
});
it('does not report a match if source hashing fails', async () => {
  const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('Synthetic internal failure'));
  try { expect(await matchQuote(request('abc', 'b'))).toMatchObject({ status: 'error', error: { code: 'EVIDENCE_FAILED' } }); }
  finally { digest.mockRestore(); }
});
it('retains surrounding negation rather than presenting a substring as an affirmative claim', async () => {
  expect(await matchQuote(request('料金は未確定。', '確定'))).toMatchObject({ status: 'matched',
    matches: [{ start: 4, end: 6, before: '料金は未', after: '。' }] });
});
it('bounds surrounding excerpts without splitting Unicode surrogate pairs', async () => {
  const result = await matchQuote(request('😀'.repeat(30) + 'x根拠y' + '😀'.repeat(30), '根拠'));
  if (!('matches' in result)) throw new Error('Expected matches');
  for (const text of [result.matches[0].before, result.matches[0].after]) {
    expect(text.length).toBeLessThanOrEqual(40);
    expect([...text].some((character) => character.length === 1 && /[\ud800-\udfff]/.test(character))).toBe(false);
  }
});

it('accepts the documented maximum sizes while keeping repeated-match output bounded', async () => {
  const result = await matchQuote(request('😀'.repeat(50000), '😀'.repeat(5000)));
  expect(result).toMatchObject({ status: 'matched', truncated: true });
  if (!('matches' in result)) throw new Error('Expected matches');
  expect(result.matches).toHaveLength(20);
  expect(result.matches.map((entry) => entry.start)).toEqual(Array.from({ length: 20 }, (_, index) => index * 2));
  expect(result.matches.every((entry) => entry.before.length <= 40 && entry.after.length <= 40)).toBe(true);
});
it('rejects an oversized quote even when the source is within its allowed size', async () => {
  expect((await matchQuote(request('x'.repeat(20000), 'x'.repeat(10001)))).status).toBe('error');
});
