/**
 * Runtime-validated, copy-on-write Domain Patch operations.
 *
 * This module deliberately operates only on the Domain Core contracts. It
 * does not know about conversations, providers, MCP, storage, or Workers.
 */

import {
  type DomainParseError,
  type DomainParseResult,
  type DomainCatalog,
  parseDomain,
  parseExpression,
  parseFunction,
  parseGoldenFixture,
  validateDomainFixtures,
} from './runtime';
import { DOMAIN_CONTRACT_VERSION } from './contract';
import type {
  DomainRule,
  DomainFunction,
  DomainGoldenFixture,
  DomainInputDefinition,
  DomainInputType,
  DomainJsonValue,
} from './contract';

export const DOMAIN_PATCH_CONTRACT_VERSION = 'domain-patch-v0' as const;
export const DOMAIN_MODEL_KIND = 'domain-model' as const;

export const DOMAIN_PATCH_ERROR_CODES = [
  'INVALID_PATCH',
  'STALE_BASE_VERSION',
  'INVALID_PROVENANCE',
  'UNSUPPORTED_OPERATION',
  'INVALID_FINAL_MODEL',
] as const;

export type DomainPatchErrorCode = (typeof DOMAIN_PATCH_ERROR_CODES)[number];
export type DomainPatchError = Omit<DomainParseError, 'code'> & {
  readonly code: DomainParseError['code'] | DomainPatchErrorCode;
};
export type DomainPatchResult<T> =
  | DomainParseResult<T>
  | {
    readonly ok: false;
    readonly error: DomainPatchError;
    readonly errors: readonly DomainPatchError[];
  };

export const SUPPORTED_DOMAIN_PATCH_OPERATIONS = [
  'add_type',
  'add_function',
  'add_rule',
  'add_example',
  'mark_unknown',
  'resolve_unknown',
  'add_conflict',
] as const;

export type DomainPatchOperationName = (typeof SUPPORTED_DOMAIN_PATCH_OPERATIONS)[number];

export interface DomainPatchProvenance {
  readonly source: string;
  readonly actor?: string;
  readonly reference?: string;
}

export interface DomainTypeDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly baseType?: DomainInputType;
  readonly fields?: readonly DomainInputDefinition[];
}

export interface DomainUnknown {
  readonly id: string;
  readonly kind: 'unknown';
  readonly subject: string;
  readonly description: string;
  readonly provenance?: DomainPatchProvenance;
}

export interface DomainConflict {
  readonly id: string;
  readonly kind: 'conflict';
  readonly subject: string;
  readonly alternatives: readonly string[];
  readonly provenance?: DomainPatchProvenance;
}

export interface DomainPatchModel {
  readonly contractVersion: typeof DOMAIN_CONTRACT_VERSION;
  readonly kind: typeof DOMAIN_MODEL_KIND;
  readonly version: string;
  readonly domain: DomainCatalog;
  readonly types: readonly DomainTypeDefinition[];
  readonly examples: readonly DomainGoldenFixture[];
  readonly unknowns: readonly DomainUnknown[];
  readonly conflicts: readonly DomainConflict[];
  readonly provenance?: DomainPatchProvenance;
}

export interface AddTypeOperation {
  readonly op: 'add_type';
  readonly type: DomainTypeDefinition;
}

export interface AddFunctionOperation {
  readonly op: 'add_function';
  readonly function: DomainFunction;
}

export interface AddRuleOperation {
  readonly op: 'add_rule';
  readonly functionId: string;
  readonly rule: DomainRule;
}

export interface AddExampleOperation {
  readonly op: 'add_example';
  readonly example: DomainGoldenFixture;
}

export interface MarkUnknownOperation {
  readonly op: 'mark_unknown';
  readonly unknown: DomainUnknown;
}

export interface ResolveUnknownOperation {
  readonly op: 'resolve_unknown';
  readonly unknownId: string;
  readonly resolution: DomainJsonValue;
}

export interface AddConflictOperation {
  readonly op: 'add_conflict';
  readonly conflict: DomainConflict;
}

export type DomainPatchOperation =
  | AddTypeOperation
  | AddFunctionOperation
  | AddRuleOperation
  | AddExampleOperation
  | MarkUnknownOperation
  | ResolveUnknownOperation
  | AddConflictOperation;

export interface DomainPatch {
  readonly contractVersion: typeof DOMAIN_PATCH_CONTRACT_VERSION;
  readonly kind: 'domain-patch';
  readonly baseVersion: string;
  readonly provenance: DomainPatchProvenance;
  readonly operations: readonly DomainPatchOperation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function patchError(
  code: DomainPatchErrorCode | DomainParseError['code'],
  path: string,
  message: string,
): DomainPatchError {
  return { code, path, message };
}

function failure<T>(error: DomainPatchError, errors: readonly DomainPatchError[] = [error]): DomainPatchResult<T> {
  return Object.freeze({ ok: false as const, error, errors: Object.freeze([...errors]) });
}

function success<T>(value: T): DomainPatchResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function isFailure<T>(result: DomainPatchResult<T>): result is Extract<DomainPatchResult<T>, { readonly ok: false }> {
  return !result.ok;
}

function nonEmptyString(value: unknown, path: string): DomainPatchResult<string> {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return failure(patchError('INVALID_PATCH', path, 'Expected a non-empty string.'));
  }
  return success(value);
}

function parseJsonValue(value: unknown, path: string): DomainPatchResult<DomainJsonValue> {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return success(value);
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? success(value)
      : failure(patchError('INVALID_PATCH', path, 'Expected a finite JSON number.'));
  }
  if (Array.isArray(value)) {
    const parsed: DomainJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = parseJsonValue(value[index], path + '[' + index + ']');
      if (isFailure(item)) return item;
      parsed.push(item.value);
    }
    return success(Object.freeze(parsed));
  }
  if (!isRecord(value)) return failure(patchError('INVALID_PATCH', path, 'Expected a JSON value.'));
  const parsed: Record<string, DomainJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const item = parseJsonValue(value[key], path + '.' + key);
    if (isFailure(item)) return item;
    parsed[key] = item.value;
  }
  return success(Object.freeze(parsed));
}

function parseProvenance(value: unknown, path: string): DomainPatchResult<DomainPatchProvenance> {
  if (!isRecord(value)) return failure(patchError('INVALID_PROVENANCE', path, 'Patch provenance is required.'));
  const allowed = new Set(['source', 'actor', 'reference']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return failure(patchError('INVALID_PROVENANCE', path + '.' + key, 'Unsupported provenance field.'));
  }
  const source = nonEmptyString(value.source, path + '.source');
  if (isFailure(source)) return failure(patchError('INVALID_PROVENANCE', source.error.path, source.error.message));
  const result: { source: string; actor?: string; reference?: string } = { source: source.value };
  for (const key of ['actor', 'reference'] as const) {
    if (hasOwn(value, key)) {
      const item = nonEmptyString(value[key], path + '.' + key);
      if (isFailure(item)) return failure(patchError('INVALID_PROVENANCE', item.error.path, item.error.message));
      result[key] = item.value;
    }
  }
  return success(Object.freeze(result));
}

function parseInputDefinitions(value: unknown, path: string): DomainPatchResult<readonly DomainInputDefinition[]> {
  if (!Array.isArray(value)) return failure(patchError('INVALID_PATCH', path, 'Expected an array of input definitions.'));
  const output: DomainInputDefinition[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) return failure(patchError('INVALID_PATCH', path + '[' + index + ']', 'Expected an input definition.'));
    const allowed = new Set(['path', 'type', 'required']);
    if (Object.keys(item).some((key) => !allowed.has(key))) return failure(patchError('INVALID_PATCH', path + '[' + index + ']', 'Unsupported input definition field.'));
    const inputPath = nonEmptyString(item.path, path + '[' + index + '].path');
    if (isFailure(inputPath)) return inputPath;
    if (seen.has(inputPath.value)) return failure(patchError('DUPLICATE_ID', path + '[' + index + '].path', 'Duplicate input path.'));
    if (item.type !== 'boolean' && item.type !== 'number' && item.type !== 'string') return failure(patchError('INVALID_PATCH', path + '[' + index + '].type', 'Unsupported input type.'));
    if (typeof item.required !== 'boolean') return failure(patchError('INVALID_PATCH', path + '[' + index + '].required', 'Expected a boolean.'));
    seen.add(inputPath.value);
    output.push(Object.freeze({ path: inputPath.value, type: item.type, required: item.required }));
  }
  return success(Object.freeze(output));
}

function parseType(value: unknown, path: string): DomainPatchResult<DomainTypeDefinition> {
  if (!isRecord(value)) return failure(patchError('INVALID_PATCH', path, 'Expected a type definition.'));
  const allowed = new Set(['id', 'name', 'description', 'baseType', 'fields']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return failure(patchError('INVALID_PATCH', path, 'Unsupported type field.'));
  const id = nonEmptyString(value.id, path + '.id');
  const name = nonEmptyString(value.name, path + '.name');
  if (isFailure(id)) return id;
  if (isFailure(name)) return name;
  const description = hasOwn(value, 'description') ? nonEmptyString(value.description, path + '.description') : success('');
  if (isFailure(description)) return description;
  let baseType: DomainInputType | undefined;
  if (hasOwn(value, 'baseType')) {
    if (value.baseType !== 'boolean' && value.baseType !== 'number' && value.baseType !== 'string') return failure(patchError('INVALID_PATCH', path + '.baseType', 'Unsupported base type.'));
    baseType = value.baseType;
  }
  let fields: readonly DomainInputDefinition[] | undefined;
  if (hasOwn(value, 'fields')) {
    const parsedFields = parseInputDefinitions(value.fields, path + '.fields');
    if (isFailure(parsedFields)) return parsedFields;
    fields = parsedFields.value;
  }
  if (baseType === undefined && fields === undefined) return failure(patchError('INVALID_PATCH', path, 'A type needs baseType or fields.'));
  return success(Object.freeze({ id: id.value, name: name.value, description: description.value, ...(baseType ? { baseType } : {}), ...(fields ? { fields } : {}) }));
}

function parseUnknown(value: unknown, path: string): DomainPatchResult<DomainUnknown> {
  if (!isRecord(value)) return failure(patchError('INVALID_PATCH', path, 'Expected an unknown item.'));
  const allowed = new Set(['id', 'kind', 'subject', 'path', 'description', 'reason', 'provenance']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return failure(patchError('INVALID_PATCH', path, 'Unsupported unknown field.'));
  const id = nonEmptyString(value.id, path + '.id');
  const subject = nonEmptyString(value.subject ?? value.path, path + '.subject');
  const description = nonEmptyString(value.description ?? value.reason, path + '.description');
  if (isFailure(id)) return id;
  if (isFailure(subject)) return subject;
  if (isFailure(description)) return description;
  if (hasOwn(value, 'kind') && value.kind !== 'unknown') return failure(patchError('INVALID_PATCH', path + '.kind', 'Unknown kind must be unknown.'));
  let provenance: DomainPatchProvenance | undefined;
  if (hasOwn(value, 'provenance')) {
    const parsed = parseProvenance(value.provenance, path + '.provenance');
    if (isFailure(parsed)) return parsed;
    provenance = parsed.value;
  }
  return success(Object.freeze({ id: id.value, kind: 'unknown' as const, subject: subject.value, description: description.value, ...(provenance ? { provenance } : {}) }));
}

function parseConflict(value: unknown, path: string): DomainPatchResult<DomainConflict> {
  if (!isRecord(value)) return failure(patchError('INVALID_PATCH', path, 'Expected a conflict item.'));
  const allowed = new Set(['id', 'kind', 'subject', 'alternatives', 'options', 'provenance']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return failure(patchError('INVALID_PATCH', path, 'Unsupported conflict field.'));
  const id = nonEmptyString(value.id, path + '.id');
  const subject = nonEmptyString(value.subject, path + '.subject');
  if (isFailure(id)) return id;
  if (isFailure(subject)) return subject;
  if (hasOwn(value, 'kind') && value.kind !== 'conflict') return failure(patchError('INVALID_PATCH', path + '.kind', 'Conflict kind must be conflict.'));
  const alternativesValue = value.alternatives ?? value.options;
  if (!Array.isArray(alternativesValue) || alternativesValue.length < 2) return failure(patchError('INVALID_PATCH', path + '.alternatives', 'A conflict needs at least two alternatives.'));
  const alternatives: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < alternativesValue.length; index += 1) {
    const item = nonEmptyString(alternativesValue[index], path + '.alternatives[' + index + ']');
    if (isFailure(item)) return item;
    if (seen.has(item.value)) return failure(patchError('DUPLICATE_ID', path + '.alternatives[' + index + ']', 'Duplicate conflict alternative.'));
    seen.add(item.value);
    alternatives.push(item.value);
  }
  let provenance: DomainPatchProvenance | undefined;
  if (hasOwn(value, 'provenance')) {
    const parsed = parseProvenance(value.provenance, path + '.provenance');
    if (isFailure(parsed)) return parsed;
    provenance = parsed.value;
  }
  return success(Object.freeze({ id: id.value, kind: 'conflict' as const, subject: subject.value, alternatives: Object.freeze(alternatives), ...(provenance ? { provenance } : {}) }));
}

function parseRule(value: unknown, path: string): DomainPatchResult<DomainRule> {
  if (!isRecord(value)) return failure(patchError('INVALID_PATCH', path, 'Expected a rule.'));
  const allowed = new Set(['id', 'priority', 'when', 'then']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return failure(patchError('INVALID_PATCH', path, 'Unsupported rule field.'));
  const id = nonEmptyString(value.id, path + '.id');
  if (isFailure(id)) return id;
  if (typeof value.priority !== 'number' || !Number.isInteger(value.priority) || !Number.isFinite(value.priority)) return failure(patchError('INVALID_PATCH', path + '.priority', 'Expected a finite integer priority.'));
  if (value.then !== 'allow' && value.then !== 'deny') return failure(patchError('INVALID_PATCH', path + '.then', 'Expected allow or deny.'));
  const when = parseExpression(value.when);
  if (isFailure(when)) return failure(patchError('INVALID_PATCH', path + '.when', when.error.message), when.errors);
  return success(Object.freeze({ id: id.value, priority: value.priority, when: when.value, then: value.then }));
}

function parseOperation(value: unknown, path: string): DomainPatchResult<DomainPatchOperation> {
  if (!isRecord(value)) return failure(patchError('INVALID_PATCH', path, 'Expected a patch operation.'));
  if (typeof value.op !== 'string') return failure(patchError('INVALID_PATCH', path + '.op', 'Operation discriminator is required.'));
  if (!SUPPORTED_DOMAIN_PATCH_OPERATIONS.includes(value.op as DomainPatchOperationName)) return failure(patchError('UNSUPPORTED_OPERATION', path + '.op', 'Unsupported Domain Patch operation: ' + value.op + '.'));
  const allowedFields: Record<DomainPatchOperationName, readonly string[]> = {
    add_type: ['op', 'type'],
    add_function: ['op', 'function'],
    add_rule: ['op', 'functionId', 'rule'],
    add_example: ['op', 'example'],
    mark_unknown: ['op', 'unknown'],
    resolve_unknown: ['op', 'unknownId', 'resolution'],
    add_conflict: ['op', 'conflict'],
  };
  const unsupportedField = Object.keys(value).find((key) => !allowedFields[value.op as DomainPatchOperationName].includes(key));
  if (unsupportedField) return failure(patchError('INVALID_PATCH', path + '.' + unsupportedField, 'Unsupported operation field.'));
  switch (value.op) {
    case 'add_type': {
      const parsed = parseType(value.type, path + '.type');
      return isFailure(parsed) ? parsed : success(Object.freeze({ op: 'add_type' as const, type: parsed.value }));
    }
    case 'add_function': {
      const parsed = parseFunction(value.function);
      return isFailure(parsed) ? failure(patchError('INVALID_PATCH', path + '.function', parsed.error.message), parsed.errors) : success(Object.freeze({ op: 'add_function' as const, function: parsed.value }));
    }
    case 'add_rule': {
      const functionId = nonEmptyString(value.functionId, path + '.functionId');
      if (isFailure(functionId)) return functionId;
      const rule = parseRule(value.rule, path + '.rule');
      return isFailure(rule) ? rule : success(Object.freeze({ op: 'add_rule' as const, functionId: functionId.value, rule: rule.value }));
    }
    case 'add_example': {
      const parsed = parseGoldenFixture(value.example);
      return isFailure(parsed) ? failure(patchError('INVALID_PATCH', path + '.example', parsed.error.message), parsed.errors) : success(Object.freeze({ op: 'add_example' as const, example: parsed.value }));
    }
    case 'mark_unknown': {
      const parsed = parseUnknown(value.unknown, path + '.unknown');
      return isFailure(parsed) ? parsed : success(Object.freeze({ op: 'mark_unknown' as const, unknown: parsed.value }));
    }
    case 'resolve_unknown': {
      const unknownId = nonEmptyString(value.unknownId, path + '.unknownId');
      if (isFailure(unknownId)) return unknownId;
      const resolution = parseJsonValue(value.resolution, path + '.resolution');
      return isFailure(resolution) ? resolution : success(Object.freeze({ op: 'resolve_unknown' as const, unknownId: unknownId.value, resolution: resolution.value }));
    }
    case 'add_conflict': {
      const parsed = parseConflict(value.conflict, path + '.conflict');
      return isFailure(parsed) ? parsed : success(Object.freeze({ op: 'add_conflict' as const, conflict: parsed.value }));
    }
  }
  return failure(patchError('UNSUPPORTED_OPERATION', path + '.op', 'Unsupported Domain Patch operation.'));
}

export function parseDomainPatch(value: unknown): DomainPatchResult<DomainPatch> {
  if (!isRecord(value)) return failure(patchError('INVALID_PATCH', '$', 'Expected a Domain Patch object.'));
  const allowed = new Set(['contractVersion', 'kind', 'baseVersion', 'provenance', 'operations']);
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported) return failure(patchError('INVALID_PATCH', '$.' + unsupported, 'Unsupported patch field.'));
  if (value.contractVersion !== DOMAIN_PATCH_CONTRACT_VERSION) return failure(patchError('INVALID_PATCH', '$.contractVersion', 'Unsupported Domain Patch contract version.'));
  if (value.kind !== 'domain-patch') return failure(patchError('INVALID_PATCH', '$.kind', 'Expected domain-patch.'));
  const baseVersion = nonEmptyString(value.baseVersion, '$.baseVersion');
  if (isFailure(baseVersion)) return baseVersion;
  const provenance = parseProvenance(value.provenance, '$.provenance');
  if (isFailure(provenance)) return provenance;
  if (!Array.isArray(value.operations)) return failure(patchError('INVALID_PATCH', '$.operations', 'Expected an array of operations.'));
  const operations: DomainPatchOperation[] = [];
  for (let index = 0; index < value.operations.length; index += 1) {
    const operation = parseOperation(value.operations[index], '$.operations[' + index + ']');
    if (isFailure(operation)) return operation;
    operations.push(operation.value);
  }
  return success(Object.freeze({
    contractVersion: DOMAIN_PATCH_CONTRACT_VERSION,
    kind: 'domain-patch' as const,
    baseVersion: baseVersion.value,
    provenance: provenance.value,
    operations: Object.freeze(operations),
  }));
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function normalizeBase(value: unknown): DomainPatchResult<DomainPatchModel> {
  if (!isRecord(value)) return failure(patchError('INVALID_FINAL_MODEL', '$', 'Expected a Domain model or catalog.'));
  const wrapped = hasOwn(value, 'domain') || value.kind === DOMAIN_MODEL_KIND;
  const source = wrapped ? value.domain : value;
  const parsedDomain = parseDomain(source);
  if (isFailure(parsedDomain)) return parsedDomain;
  const versionValue = wrapped ? value.version : (hasOwn(value, 'version') ? value.version : DOMAIN_CONTRACT_VERSION);
  const version = nonEmptyString(versionValue, '$.version');
  if (isFailure(version)) return failure(patchError('INVALID_FINAL_MODEL', version.error.path, version.error.message));
  const parseCollection = <T>(key: string, parser: (item: unknown, path: string) => DomainPatchResult<T>): DomainPatchResult<readonly T[]> => {
    const sourceCollection = wrapped ? value[key] : undefined;
    if (sourceCollection === undefined) return success(Object.freeze([]));
    if (!Array.isArray(sourceCollection)) return failure(patchError('INVALID_FINAL_MODEL', '$.' + key, 'Expected an array.'));
    const output: T[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < sourceCollection.length; index += 1) {
      const parsed = parser(sourceCollection[index], '$.' + key + '[' + index + ']');
      if (isFailure(parsed)) return parsed;
      const item = parsed.value as T & { readonly id?: string };
      if (typeof item.id === 'string') {
        if (seen.has(item.id)) return failure(patchError('DUPLICATE_ID', '$.' + key + '[' + index + '].id', "Identifier '" + item.id + "' already exists."));
        seen.add(item.id);
      }
      output.push(parsed.value);
    }
    return success(Object.freeze(output));
  };
  const types = parseCollection('types', parseType);
  if (isFailure(types)) return types;
  const examples = parseCollection('examples', (item) => parseGoldenFixture(item));
  if (isFailure(examples)) return examples;
  const unknowns = parseCollection('unknowns', parseUnknown);
  if (isFailure(unknowns)) return unknowns;
  const conflicts = parseCollection('conflicts', parseConflict);
  if (isFailure(conflicts)) return conflicts;
  const provenance = wrapped && hasOwn(value, 'provenance') ? parseProvenance(value.provenance, '$.provenance') : undefined;
  if (provenance && isFailure(provenance)) return provenance;
  return success({
    contractVersion: DOMAIN_CONTRACT_VERSION,
    kind: DOMAIN_MODEL_KIND,
    version: version.value,
    domain: parsedDomain.value,
    types: types.value,
    examples: examples.value,
    unknowns: unknowns.value,
    conflicts: conflicts.value,
    ...(provenance && !isFailure(provenance) ? { provenance: provenance.value } : {}),
  });
}

function duplicate(collection: readonly { readonly id: string }[], id: string, path: string): DomainPatchResult<never> | undefined {
  return collection.some((item) => item.id === id) ? failure(patchError('DUPLICATE_ID', path, "Identifier '" + id + "' already exists.")) : undefined;
}

function finalValidate(candidate: DomainPatchModel): DomainPatchResult<DomainPatchModel> {
  const parsedDomain = parseDomain(candidate.domain);
  if (isFailure(parsedDomain)) return parsedDomain;
  if (candidate.examples.length > 0) {
    const examples = validateDomainFixtures(parsedDomain.value, candidate.examples);
    if (isFailure(examples)) return examples;
  }
  return success(deepFreeze({ ...candidate, domain: parsedDomain.value }));
}

/** Apply a validated patch atomically. The input model is never mutated. */
export function applyDomainPatch(base: unknown, patch: unknown): DomainPatchResult<DomainPatchModel> {
  const parsedPatch = parseDomainPatch(patch);
  if (isFailure(parsedPatch)) return parsedPatch;
  const parsedBase = normalizeBase(base);
  if (isFailure(parsedBase)) return parsedBase;
  const current = parsedBase.value;
  if (parsedPatch.value.baseVersion !== current.version) {
    return failure(patchError('STALE_BASE_VERSION', '$.baseVersion', "Patch targets '" + parsedPatch.value.baseVersion + "' but the model is at '" + current.version + "'."));
  }
  if (current.provenance && stableJson(current.provenance) !== stableJson(parsedPatch.value.provenance)) {
    return failure(patchError('INVALID_PROVENANCE', '$.provenance', 'Patch provenance does not match the model provenance.'));
  }

  let candidate: DomainPatchModel;
  try {
    candidate = jsonClone(current);
  } catch {
    return failure(patchError('INVALID_FINAL_MODEL', '$', 'The model could not be copied safely.'));
  }
  for (let index = 0; index < parsedPatch.value.operations.length; index += 1) {
    const operation = parsedPatch.value.operations[index];
    const path = '$.operations[' + index + ']';
    switch (operation.op) {
      case 'add_type': {
        const duplicateResult = duplicate(candidate.types, operation.type.id, path + '.type.id');
        if (duplicateResult) return duplicateResult;
        candidate = { ...candidate, types: [...candidate.types, operation.type] };
        break;
      }
      case 'add_function': {
        const duplicateResult = duplicate(candidate.domain.functions, operation.function.id, path + '.function.id');
        if (duplicateResult) return duplicateResult;
        candidate = { ...candidate, domain: { ...candidate.domain, functions: [...candidate.domain.functions, operation.function] } };
        break;
      }
      case 'add_rule': {
        const functionIndex = candidate.domain.functions.findIndex((item) => item.id === operation.functionId);
        if (functionIndex < 0) return failure(patchError('INVALID_REFERENCE', path + '.functionId', "Function '" + operation.functionId + "' is not declared."));
        const duplicateRule = candidate.domain.functions.some((item) => item.policy.rules.some((rule) => rule.id === operation.rule.id));
        if (duplicateRule) return failure(patchError('DUPLICATE_ID', path + '.rule.id', "Identifier '" + operation.rule.id + "' already exists."));
        const domainFunction = candidate.domain.functions[functionIndex];
        const updatedFunction: DomainFunction = { ...domainFunction, policy: { ...domainFunction.policy, rules: [...domainFunction.policy.rules, operation.rule] } };
        candidate = { ...candidate, domain: { ...candidate.domain, functions: candidate.domain.functions.map((item, itemIndex) => itemIndex === functionIndex ? updatedFunction : item) } };
        break;
      }
      case 'add_example': {
        const duplicateResult = duplicate(candidate.examples, operation.example.id, path + '.example.id');
        if (duplicateResult) return duplicateResult;
        candidate = { ...candidate, examples: [...candidate.examples, operation.example] };
        break;
      }
      case 'mark_unknown': {
        const duplicateResult = duplicate(candidate.unknowns, operation.unknown.id, path + '.unknown.id');
        if (duplicateResult) return duplicateResult;
        candidate = { ...candidate, unknowns: [...candidate.unknowns, operation.unknown] };
        break;
      }
      case 'resolve_unknown': {
        if (!candidate.unknowns.some((item) => item.id === operation.unknownId)) return failure(patchError('INVALID_REFERENCE', path + '.unknownId', "Unknown item '" + operation.unknownId + "' is not declared."));
        candidate = { ...candidate, unknowns: candidate.unknowns.filter((item) => item.id !== operation.unknownId) };
        break;
      }
      case 'add_conflict': {
        const duplicateResult = duplicate(candidate.conflicts, operation.conflict.id, path + '.conflict.id');
        if (duplicateResult) return duplicateResult;
        candidate = { ...candidate, conflicts: [...candidate.conflicts, operation.conflict] };
        break;
      }
    }
  }
  return finalValidate(candidate);
}

export const applyPatch = applyDomainPatch;
export const validateDomainPatch = parseDomainPatch;
