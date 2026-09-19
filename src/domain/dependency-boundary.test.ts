import { describe, expect, it } from 'vitest';
import {
  getDomainMetadata,
  parseDomain,
  parseExpression,
  ping,
} from './index';

describe('Domain Core dependency boundary', () => {
  it('imports and validates without Worker, MCP, storage, or LLM modules', () => {
    expect(getDomainMetadata().name).toBe('invariant-domain-core');
    expect(ping()).toEqual({ ok: true });
    expect(parseExpression({
      id: 'node.boundary.literal',
      kind: 'literal',
      value: true,
    })).toMatchObject({ ok: true });
    expect(parseDomain({
      contractVersion: 'domain-v0',
      kind: 'function-catalog',
      functions: [],
    })).toMatchObject({ ok: true });
  });
});
