import { expect, it } from 'vitest';
import { calculate } from './calculation';
const request = (input: Record<string, unknown>) => calculate({ version: 'calculation-v1', ...input });

it.each([
  ['add', '0.1', '0.2', '0.3'],
  ['add', '9007199254740993', '1', '9007199254740994'],
  ['subtract', '1', '1.0001', '-0.0001'],
  ['multiply', '1.25', '0.08', '0.1'],
  ['divide', '1', '8', '0.125'],
  ['divide', '-2', '-0.5', '4'],
])('%s uses exact decimal arithmetic (%s, %s)', (operation, left, right, expected) => {
  expect(request({ operation, left, right })).toMatchObject({ status: 'ok', result: { decimal: expected }, scope: 'arithmetic_for_supplied_inputs' });
});
it('preserves a repeating fraction instead of pretending a rounded decimal is exact', () => {
  expect(request({ operation: 'divide', left: '1', right: '3', decimalPlaces: 8 })).toMatchObject({
    status: 'ok', result: { numerator: '1', denominator: '3', decimal: null },
    display: { value: '0.33333333', exact: false, rounding: 'half_even' },
  });
});
it.each([['2.5', '2'], ['3.5', '4'], ['-2.5', '-2'], ['-3.5', '-4']])('rounds %s with explicit half-even semantics', (left, expected) => {
  expect(request({ operation: 'add', left, right: '0', decimalPlaces: 0 })).toMatchObject({ status: 'ok', display: { value: expected, exact: false } });
});
it('uses distinct parameter names and formulas for percentage amount and change', () => {
  expect(request({ operation: 'percentage_of', amount: '250', percent: '12.5' })).toMatchObject({ status: 'ok', result: { decimal: '31.25' } });
  expect(request({ operation: 'percentage_change', from: '80', to: '100' })).toMatchObject({ status: 'ok', result: { decimal: '25' } });
  expect(request({ operation: 'percentage_change', from: '100', to: '80' })).toMatchObject({ status: 'ok', result: { decimal: '-20' } });
});
it.each([
  { operation: 'add', left: 0.1, right: '0.2' },
  { operation: 'divide', left: '1', right: '0' },
  { operation: 'add', left: '1e3', right: '1' },
  { operation: 'add', left: '1,000', right: '1' },
  { operation: 'add', left: '1', right: '1', decimalPlaces: 51 },
  { operation: 'add', left: '1' },
  { operation: 'percentage_change', from: '0', to: '10' },
  { operation: 'percentage_change', from: '-10', to: '10' },
  { operation: 'add', left: '1'.repeat(201), right: '1' },
])('rejects invalid, undefined, or ambiguous inputs without guessing: %j', (input) => {
  expect(request(input).status).toBe('error');
});
it('records immutable inputs and steps and returns repeatable output', () => {
  const input = { operation: 'percentage_change', from: '80', to: '100' };
  const result = request(input); expect(request(input)).toEqual(result);
  if (result.status !== 'ok') throw new Error('Expected success');
  expect(result.steps).toHaveLength(3);
  expect(Object.isFrozen(result.inputs)).toBe(true); expect(Object.isFrozen(result.steps[0].result)).toBe(true);
  input.from = '100'; expect(result.inputs.from).toBe('80');
});

it('rejects a mismatched implementation pin rather than silently running different code', () => {
  expect(request({ operation: 'add', left: '1', right: '2', implementationHash: '0'.repeat(64) })).toMatchObject({
    status: 'error', error: { code: 'UNSUPPORTED_IMPLEMENTATION' },
  });
});

it('does not invoke accessors or let recorded inputs differ from computed inputs', () => {
  let reads = 0;
  const input = { version: 'calculation-v1', operation: 'add', get left() { reads++; return reads === 1 ? '1' : '99'; }, right: '2' };
  expect(calculate(input)).toMatchObject({ status: 'error', error: { code: 'INVALID_INPUT' } });
  expect(reads).toBe(0);
});
