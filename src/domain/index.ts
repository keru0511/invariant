/**
 * Invariant domain core public exports.
 *
 * Keep this index dependency-free: worker, MCP, persistence, and network code
 * remain outside the domain namespace.
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
export * from './test-runner';
export * from './evaluation';
export * from './patch';
export * from './conversation-patch';
