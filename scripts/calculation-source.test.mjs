import { expect, it } from 'vitest';
import { calculationSourceHash } from './calculation-source.mjs';
import { CALCULATION_SOURCE_HASH } from '../src/domain/calculation-source';
it('records the actual calculator source rather than silently reusing an implementation identity', async () => {
  expect(await calculationSourceHash()).toBe(CALCULATION_SOURCE_HASH);
});
