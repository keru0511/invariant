import { expect, it } from 'vitest';
import reference from '../../fixtures/calculation-v1/reference.json';
import { calculate, verifyCalculation } from './calculation';

// Expected values are generated separately with Python's Fraction/Decimal.
// Never overwrite them from production calculator output to make a test pass.
it.each(reference.cases)('matches independent arithmetic oracle $id', (fixture) => {
  const result = calculate(fixture.input);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(result.error.message);
  expect(result.result).toEqual(fixture.expected);
  if ('display' in fixture) expect(result.display).toEqual(fixture.display);
});

it.each(reference.cases)('accepts the oracle claim and rejects a perturbed numerator $id', (fixture) => {
  const claim = { kind: 'exact_fraction', functionId: `decimal.${fixture.input.operation}@1`,
    numerator: fixture.expected.numerator, denominator: fixture.expected.denominator };
  expect(verifyCalculation(fixture.input, claim).status).toBe('verified');
  expect(verifyCalculation(fixture.input, { ...claim, numerator: (BigInt(claim.numerator) + 1n).toString() }).status).toBe('mismatch');
  if (fixture.display) expect(verifyCalculation(fixture.input, { kind: 'rounded_decimal', functionId: claim.functionId,
    value: fixture.display.value, decimalPlaces: fixture.display.decimalPlaces }).status).toBe('verified');
});
