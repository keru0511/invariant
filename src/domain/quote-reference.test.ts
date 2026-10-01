import { expect, it } from 'vitest';
import reference from '../../fixtures/quote-evidence-v1/reference.json';
import { matchQuote } from './quote-evidence';

// Fixed expected results are authored with Python, not copied from matchQuote.
it.each(reference.cases)('matches independent Unicode/offset/hash oracle $id', async (fixture) => {
  const result = await matchQuote(fixture.input);
  expect(result.status).toBe(fixture.expected.status);
  if (!('matches' in result)) throw new Error('Expected a literal comparison result');
  expect(result.matches).toEqual(fixture.expected.matches);
  expect(result.truncated).toBe(fixture.expected.truncated);
  expect(result.source.hash).toBe(fixture.expected.hash);
});
