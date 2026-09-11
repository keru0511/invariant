import { describe, expect, it } from 'vitest';
import { getDomainMetadata, ping } from './index';

describe('Domain Core (ドメインコア)', () => {
  it('外部依存なしに正常なドメインメタデータを返却する', () => {
    const metadata = getDomainMetadata();
    expect(metadata).toEqual({
      name: 'invariant-domain-core',
      version: '0.0.1',
      status: 'ready',
    });
  });

  it('ping を決定論的に評価して { ok: true } を返却する', () => {
    const result = ping();
    expect(result).toEqual({ ok: true });
  });
});
