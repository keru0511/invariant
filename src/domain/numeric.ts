/**
 * v0 uses binary floating-point numbers, not arbitrary-precision decimals.
 * Reject non-finite values and integers outside the exact-integer range before
 * they can become rule facts, literals, or priorities. High-precision values
 * need a separately typed representation rather than silent JS rounding.
 */
export function isDomainNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value));
}
