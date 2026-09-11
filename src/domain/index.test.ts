import { describe, expect, it } from 'vitest';
import { getDomainMetadata, ping } from './index';

describe('Domain Core', () => {
  it('returns valid domain metadata without external dependencies', () => {
    const metadata = getDomainMetadata();
    expect(metadata).toEqual({
      name: 'invariant-domain-core',
      version: '0.0.1',
      status: 'ready',
    });
  });

  it('evaluates ping deterministically returning { ok: true }', () => {
    const result = ping();
    expect(result).toEqual({ ok: true });
  });
});
