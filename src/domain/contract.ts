/**
 * Domain v0 contract.
 *
 * This file deliberately contains only data contracts and stable constants.
 * It has no Worker, MCP, network, or evaluator dependency.
 */

export const DOMAIN_CONTRACT_VERSION = 'domain-v0' as const;

export const SUPPORTED_NODE_KINDS = [
  'literal',
  'input',
  'compare',
  'logical',
  'not',
] as const;

export const SUPPORTED_OPERATORS = [
  'and',
  'or',
  'not',
  'eq',
  'lt',
  'lte',
  'gt',
  'gte',
] as const;

export const SUPPORTED_RESULT_STATUSES = [
  'allow',
  'deny',
  'unresolved',
  'conflict',
  'ambiguous',
  'error',
] as const;

export const SUPPORTED_ERROR_CODES = [
  'MISSING_INPUT',
  'TYPE_MISMATCH',
  'RULE_CONFLICT',
  'AMBIGUOUS_MATCH',
  'INVALID_AST',
] as const;

export type DomainNodeKind = (typeof SUPPORTED_NODE_KINDS)[number];
export type DomainOperator = (typeof SUPPORTED_OPERATORS)[number];
export type DomainResultStatus = (typeof SUPPORTED_RESULT_STATUSES)[number];
export type DomainErrorCode = (typeof SUPPORTED_ERROR_CODES)[number];
export type DomainInputType = 'boolean' | 'number' | 'string';
export type DomainDecision = 'allow' | 'deny';
export type DomainConditionResult = boolean | 'unresolved';
export type DomainScalar = boolean | number | string | null;

export interface DomainJsonObject {
  readonly [key: string]: DomainJsonValue;
}

export type DomainJsonValue = DomainScalar | DomainJsonObject | readonly DomainJsonValue[];

export interface LiteralNode {
  readonly id: string;
  readonly kind: 'literal';
  readonly value: DomainScalar;
}

export interface InputNode {
  readonly id: string;
  readonly kind: 'input';
  readonly path: string;
}

export interface CompareNode {
  readonly id: string;
  readonly kind: 'compare';
  readonly operator: 'eq' | 'lt' | 'lte' | 'gt' | 'gte';
  readonly left: DomainExpression;
  readonly right: DomainExpression;
}

export interface LogicalNode {
  readonly id: string;
  readonly kind: 'logical';
  readonly operator: 'and' | 'or';
  readonly operands: readonly DomainExpression[];
}

export interface NotNode {
  readonly id: string;
  readonly kind: 'not';
  readonly operand: DomainExpression;
}

export type DomainExpression =
  | LiteralNode
  | InputNode
  | CompareNode
  | LogicalNode
  | NotNode;

export interface DomainInputDefinition {
  readonly path: string;
  readonly type: DomainInputType;
  readonly required: boolean;
}

export interface DomainRule {
  readonly id: string;
  readonly priority: number;
  readonly when: DomainExpression;
  readonly then: DomainDecision;
}

export interface DomainResolutionPolicy {
  readonly priority: 'highest';
  readonly unresolved: 'unresolved';
  readonly conflict: 'conflict';
  readonly ambiguous: 'ambiguous';
  readonly noMatch: 'default';
}

export interface DomainPolicy {
  readonly id: string;
  readonly defaultStatus: DomainDecision | 'unresolved';
  readonly resolution: DomainResolutionPolicy;
  readonly rules: readonly DomainRule[];
}

export interface DomainFunction {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly DomainInputDefinition[];
  readonly policy: DomainPolicy;
}

export type DomainTraceStage = 'input' | 'literal' | 'operator' | 'rule' | 'policy';
export type DomainTraceOutcome =
  | boolean
  | 'unresolved'
  | 'allow'
  | 'deny'
  | 'conflict'
  | 'ambiguous'
  | 'error';

export interface DomainTraceEvent {
  readonly id: string;
  readonly stage: DomainTraceStage;
  readonly nodeId?: string;
  readonly ruleId?: string;
  readonly operator?: DomainOperator;
  readonly outcome: DomainTraceOutcome;
  readonly observed?: DomainJsonValue;
}

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly ruleIds?: readonly string[];
}

export interface DomainProvenance {
  readonly fixtureId: string;
  readonly functionId: string;
  readonly policyId: string;
  readonly inputPaths: readonly string[];
  readonly ruleIds: readonly string[];
}

export interface DomainExpectedResult {
  readonly status: DomainResultStatus;
  readonly value: boolean | null;
  readonly matchedRuleIds: readonly string[];
  readonly unresolvedPaths: readonly string[];
  readonly errors: readonly DomainError[];
  readonly trace: readonly DomainTraceEvent[];
  readonly provenance: DomainProvenance;
}

export type DomainFixtureCategory =
  | 'valid'
  | 'boundary'
  | 'unresolved'
  | 'conflict'
  | 'ambiguous'
  | 'invalid';

export interface DomainGoldenFixture {
  readonly id: string;
  readonly kind: 'golden-evaluation';
  readonly contractVersion: typeof DOMAIN_CONTRACT_VERSION;
  readonly category: DomainFixtureCategory;
  readonly functionId: string;
  readonly description: string;
  readonly input: DomainJsonObject;
  readonly expected: DomainExpectedResult;
}

export interface DomainFixtureManifestEntry {
  readonly id: string;
  readonly path: string;
  readonly category: DomainFixtureCategory;
}

export interface DomainFixtureManifest {
  readonly contractVersion: typeof DOMAIN_CONTRACT_VERSION;
  readonly fixtureSetId: string;
  readonly functionsFile: string;
  readonly fixtures: readonly DomainFixtureManifestEntry[];
  readonly supported: {
    readonly nodeKinds: readonly DomainNodeKind[];
    readonly operators: readonly DomainOperator[];
    readonly statuses: readonly DomainResultStatus[];
  };
}
