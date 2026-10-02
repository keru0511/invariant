import { describe, expect, it } from 'vitest';
import { isDomainNumber } from './numeric';
import { parseExpression } from './runtime';

describe('v0 numeric representation boundary', () => {
  it.each([0, -0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0.5, -2.25])('accepts supported number %s', (value) => {
    expect(isDomainNumber(value)).toBe(true);
    expect(parseExpression({ id: 'n', kind: 'literal', value }).ok).toBe(true);
  });
  it.each([Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1])('rejects unsupported number %s in both facts and literals', (value) => {
    expect(isDomainNumber(value)).toBe(false);
    expect(parseExpression({ id: 'n', kind: 'literal', value }).ok).toBe(false);
  });
});
