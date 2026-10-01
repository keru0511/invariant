import { expect, it } from 'vitest';
import { verifyCalculation } from './calculation';
const request = { version: 'calculation-v1', operation: 'divide', left: '1', right: '3', decimalPlaces: 2 };
const exact = { kind: 'exact_fraction', functionId: 'decimal.divide@1', numerator: '1', denominator: '3' };
const display = { kind: 'rounded_decimal', functionId: 'decimal.divide@1', value: '0.33', decimalPlaces: 2 };
it('verifies equivalent fractions but not approximations labeled exact', () => {
  expect(verifyCalculation(request, exact).status).toBe('verified');
  expect(verifyCalculation(request, { ...exact, numerator: '2', denominator: '6' }).status).toBe('verified');
  expect(verifyCalculation(request, { ...exact, numerator: '33', denominator: '100' }).status).toBe('mismatch');
});
it('requires the same operation identity even when two operations happen to agree', () => {
  expect(verifyCalculation({ version: 'calculation-v1', operation: 'add', left: '2', right: '2' },
    { ...exact, functionId: 'decimal.multiply@1', numerator: '4', denominator: '1' }).status).toBe('mismatch');
});
it('verifies only the requested rounded representation', () => {
  expect(verifyCalculation(request, display)).toMatchObject({ status: 'verified', expected: { display: { exact: false } }, scope: 'numeric_claim_for_supplied_request' });
  expect(verifyCalculation(request, { ...display, value: '0.34' }).status).toBe('mismatch');
  expect(verifyCalculation(request, { ...display, decimalPlaces: 3 }).status).toBe('mismatch');
  const { decimalPlaces: _, ...unrounded } = request;
  expect(verifyCalculation(unrounded, display)).toMatchObject({ status: 'error', error: { code: 'MISSING_PRECISION' } });
});
it.each([
  { ...exact, denominator: '0' }, { ...exact, numerator: '1e3' }, { ...exact, numerator: '1'.repeat(1002) },
  { ...exact, extra: 'claim' }, { ...exact, kind: 'prose' }, { ...display, decimalPlaces: 51 },
])('rejects malformed claims: %j', (claim) => {
  expect(verifyCalculation(request, claim).status).toBe('error');
});
it('never verifies an invalid calculation or invokes claim accessors', () => {
  expect(verifyCalculation({ ...request, right: '0' }, exact).status).toBe('error');
  let reads = 0;
  expect(verifyCalculation(request, { ...exact, get numerator() { reads++; return '1'; } }).status).toBe('error');
  expect(reads).toBe(0);
});
