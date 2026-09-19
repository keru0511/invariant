/**
 * Invariant ドメインコア
 *
 * 本モジュールは純粋な TypeScript で実装されており、Cloudflare Workers や MCP、
 * 外部 HTTP ライブラリに一切依存してはなりません。すべてのドメインモデル、
 * AST 型定義、決定論的評価ロジック、ビジネスルールをこの名前空間に配置します。
 */

export interface DomainMetadata {
  readonly name: string;
  readonly version: string;
  readonly status: 'initialized' | 'ready';
}

export function getDomainMetadata(): DomainMetadata {
  return {
    name: 'invariant-domain-core',
    version: '0.0.1',
    status: 'ready',
  };
}

export interface PingResult {
  readonly ok: true;
}

export function ping(): PingResult {
  return { ok: true };
}

export * from './contract';
export * from './runtime';
export * from './evaluator';
export * from './decision';
