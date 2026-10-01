import { CALCULATION_SOURCE_HASH } from './calculation-source';
export { CALCULATION_SOURCE_HASH } from './calculation-source';
/** Exact arithmetic over caller-supplied decimal strings. No eval, I/O, or LLM. */
export const CALCULATION_VERSION = 'calculation-v1' as const;
export const MAX_DECIMAL_DIGITS = 200;
export const MAX_DECIMAL_PLACES = 50;

type Operation = 'add' | 'subtract' | 'multiply' | 'divide' | 'percentage_of' | 'percentage_change';
interface Fraction { readonly n: bigint; readonly d: bigint; }
export interface ExactValue { readonly numerator: string; readonly denominator: string; readonly decimal: string | null; }
interface FunctionSpec { readonly operation: Operation; readonly parameters: readonly string[]; readonly formula: string; readonly constraint: string; }
const spec = (operation: Operation, parameters: string[], formula: string, constraint = 'Finite decimal strings; input facts are not independently verified.'): FunctionSpec =>
  Object.freeze({ operation, parameters: Object.freeze(parameters), formula, constraint });
export const CALCULATION_FUNCTIONS: readonly FunctionSpec[] = Object.freeze([
  spec('add', ['left', 'right'], 'left + right'),
  spec('subtract', ['left', 'right'], 'left - right'),
  spec('multiply', ['left', 'right'], 'left * right'),
  spec('divide', ['left', 'right'], 'left / right', 'right must be nonzero.'),
  spec('percentage_of', ['amount', 'percent'], 'amount * percent / 100'),
  spec('percentage_change', ['from', 'to'], '(to - from) / from * 100', 'from must be positive; result is a percentage.'),
]);
class CalculationFailure extends Error {
  constructor(readonly code: string, message: string, readonly path?: string) { super(message); }
}
const fail = (code: string, message: string, path?: string): never => { throw new CalculationFailure(code, message, path); };
const abs = (value: bigint) => value < 0n ? -value : value;
function fraction(n: bigint, d: bigint): Fraction {
  if (d === 0n) return fail('DIVISION_BY_ZERO', 'Division by zero is undefined.');
  if (d < 0n) { n = -n; d = -d; }
  let a = abs(n), b = d;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return Object.freeze({ n: n / a, d: d / a });
}
function decimal(value: unknown, path: string): Fraction {
  if (typeof value !== 'string' || value.length > MAX_DECIMAL_DIGITS + 2
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    return fail('INVALID_DECIMAL', 'Use a bounded plain decimal string, without units, separators, or exponent notation.', path);
  }
  const digits = value.replace(/[+.-]/g, '');
  if (digits.length > MAX_DECIMAL_DIGITS) return fail('INPUT_TOO_LARGE', 'Decimal digit limit exceeded.', path);
  const unsigned = value.replace(/^[+-]/, '');
  const [whole, part = ''] = unsigned.split('.');
  const n = BigInt((whole || '0') + part) * (value.startsWith('-') ? -1n : 1n);
  return fraction(n, 10n ** BigInt(part.length));
}
const add = (a: Fraction, b: Fraction) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Fraction, b: Fraction) => fraction(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Fraction, b: Fraction) => fraction(a.n * b.n, a.d * b.d);
const div = (a: Fraction, b: Fraction) => fraction(a.n * b.d, a.d * b.n);
function fixed(integer: bigint, scale: number, negative: boolean): string {
  const digits = integer.toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : digits.slice(0, -scale) + '.' + digits.slice(-scale);
  return negative && integer !== 0n ? '-' + text : text;
}
function exactDecimal(value: Fraction): string | null {
  let denominator = value.d, twos = 0, fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
  if (denominator !== 1n) return null;
  const scale = Math.max(twos, fives);
  const text = fixed(abs(value.n) * 10n ** BigInt(scale) / value.d, scale, value.n < 0n);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}
function exact(value: Fraction): ExactValue {
  return Object.freeze({ numerator: value.n.toString(), denominator: value.d.toString(), decimal: exactDecimal(value) });
}
function rounded(value: Fraction, places: number) {
  const scaled = abs(value.n) * 10n ** BigInt(places);
  let quotient = scaled / value.d;
  const remainder = scaled % value.d;
  if (remainder * 2n > value.d || (remainder * 2n === value.d && quotient % 2n !== 0n)) quotient++;
  return Object.freeze({ value: fixed(quotient, places, value.n < 0n), decimalPlaces: places,
    rounding: 'half_even' as const, exact: remainder === 0n });
}

export type CalculationResult = {
  readonly status: 'ok'; readonly implementationHash: string; readonly version: typeof CALCULATION_VERSION; readonly functionId: string;
  readonly inputs: Readonly<Record<string, string>>; readonly formula: string;
  readonly scope: 'arithmetic_for_supplied_inputs'; readonly result: ExactValue;
  readonly display?: ReturnType<typeof rounded>;
  readonly steps: readonly { readonly operation: string; readonly result: ExactValue }[];
} | { readonly status: 'error'; readonly version: typeof CALCULATION_VERSION; readonly error: { readonly code: string; readonly message: string; readonly path?: string }; };

export function calculate(input: unknown): CalculationResult {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return fail('INVALID_INPUT', 'Expected a plain calculation request.');
    // Snapshot data properties without invoking getters or retaining caller-owned state.
    const request: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        return fail('INVALID_INPUT', 'Only enumerable data fields are accepted.');
      }
      request[key] = descriptor.value;
    }
    if (request.version !== CALCULATION_VERSION) return fail('UNSUPPORTED_VERSION', 'Select calculation-v1 explicitly.', 'version');
    const definition = CALCULATION_FUNCTIONS.find((item) => item.operation === request.operation);
    if (!definition) return fail('UNSUPPORTED_OPERATION', 'Select a declared calculation function.', 'operation');
    if (Object.hasOwn(request, 'implementationHash') && request.implementationHash !== CALCULATION_SOURCE_HASH) return fail('UNSUPPORTED_IMPLEMENTATION', 'The requested calculator implementation is not available.', 'implementationHash');
    const keys = new Set(['version', 'implementationHash', 'operation', 'decimalPlaces', ...definition.parameters]);
    for (const key of Object.keys(request)) if (!keys.has(key)) return fail('INVALID_INPUT', 'Unexpected calculation field.', key);
    let places: number | undefined;
    if (Object.hasOwn(request, 'decimalPlaces')) {
      const value = request.decimalPlaces;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_DECIMAL_PLACES) {
        return fail('INVALID_PRECISION', 'decimalPlaces must be an integer from 0 to 50.', 'decimalPlaces');
      }
      places = value;
    }
    const inputs: Record<string, string> = {};
    const values = definition.parameters.map((key) => {
      if (!Object.hasOwn(request, key)) return fail('MISSING_INPUT', 'A required input is absent; do not infer it.', key);
      const parsed = decimal(request[key], key); inputs[key] = request[key] as string; return parsed;
    });
    const [a, b] = values;
    const steps: Array<{ readonly operation: string; readonly result: ExactValue }> = [];
    const step = (operation: string, value: Fraction) => { steps.push(Object.freeze({ operation, result: exact(value) })); return value; };
    let answer: Fraction;
    switch (definition.operation) {
      case 'add': answer = step('add', add(a, b)); break;
      case 'subtract': answer = step('subtract', sub(a, b)); break;
      case 'multiply': answer = step('multiply', mul(a, b)); break;
      case 'divide': answer = step('divide', div(a, b)); break;
      case 'percentage_of': answer = step('divide_by_100', div(step('multiply', mul(a, b)), fraction(100n, 1n))); break;
      case 'percentage_change': {
        if (a.n <= 0n) return fail('INVALID_BASELINE', 'Percentage change requires a positive starting value.', 'from');
        answer = step('multiply_by_100', mul(step('divide_by_from', div(step('to_minus_from', sub(b, a)), a)), fraction(100n, 1n)));
        break;
      }
    }
    return Object.freeze({ status: 'ok', version: CALCULATION_VERSION, implementationHash: CALCULATION_SOURCE_HASH, functionId: `decimal.${definition.operation}@1`,
      inputs: Object.freeze(inputs), formula: definition.formula, scope: 'arithmetic_for_supplied_inputs',
      result: exact(answer), steps: Object.freeze(steps), ...(places === undefined ? {} : { display: rounded(answer, places) }),
    });
  } catch (error) {
    const failure = error instanceof CalculationFailure ? error : new CalculationFailure('CALCULATION_FAILED', 'Calculation could not be completed.');
    return Object.freeze({ status: 'error', version: CALCULATION_VERSION, error: Object.freeze({ code: failure.code, message: failure.message,
      ...(failure.path ? { path: failure.path } : {}),
    }) });
  }
}
