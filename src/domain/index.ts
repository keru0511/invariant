/**
 * Invariant Domain Core
 *
 * This module is pure TypeScript: it MUST NOT depend on Cloudflare Workers,
 * MCP, or external HTTP libraries. All domain models, AST types, evaluation,
 * and business rules belong in this namespace.
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

