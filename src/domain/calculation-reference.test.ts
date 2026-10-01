import { expect, it } from 'vitest';
import reference from '../../fixtures/calculation-v1/reference.json';
import { calculate } from './calculation';

// Expected values are generated separately with Python's Fraction/Decimal.
// Never overwrite them from production calculator output to make a test pass.
it.each(reference.cases)('matches independent arithmetic oracle $id', (fixture) => {
  const result = calculate(fixture.input);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(result.error.message);
  expect(result.result).toEqual(fixture.expected);
  if ('display' in fixture) expect(result.display).toEqual(fixture.display);
});
