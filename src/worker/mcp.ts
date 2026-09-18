import {
  McpServer,
  createMcpHandler,
  originValidationResponse,
  localhostAllowedOrigins,
} from '@modelcontextprotocol/server';
import type { AuthInfo, McpRequestContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  evaluate,
  parseDomain,
  ping,
  type DomainFunction,
  type DomainInputDefinition,
  type DomainParseError,
  type DomainProvenance,
} from '../domain';
import {
  CF_ACCESS_JWT_ASSERTION_HEADER,
  createAccessTokenVerifier,
} from './access-auth';
import type { AccessPrincipal, AccessTokenVerifier } from './access-auth';
import type { Env } from './env';
import {
  AuthWorkspaceRepositoryAdapter,
  DomainRepositoryError,
  D1WorkspaceMembershipRepository,
  PUBLIC_RESOURCE_NOT_FOUND,
  WorkspaceAccessError,
  type DomainVersionRecord,
  type ScopedLoadDomainVersionInput,
} from '../persistence';
import { createDomainRepository } from '../persistence/domain-repository';

const ALLOWED_ORIGIN_HOSTNAMES = localhostAllowedOrigins();

function getCorsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Cf-Access-Jwt-Assertion',
  };
}

export const VERIFIED_PRINCIPAL_AUTH_INFO_KEY = 'invariantAccessPrincipal';

export interface McpWorkspaceDomainRepository {
  loadVersion(input: ScopedLoadDomainVersionInput): Promise<DomainVersionRecord>;
}

export interface McpWorkspaceRepository {
  forPrincipal(
    principal: AccessPrincipal,
    workspaceId: string,
  ): Promise<McpWorkspaceDomainRepository>;
}

export interface McpRequestDependencies {
  /** Test-only seam; production requests must resolve the configured provider. */
  readonly accessVerifier?: AccessTokenVerifier;
  /** Test-only seam; production requests resolve this from Env.DB. */
  readonly workspaceRepository?: McpWorkspaceRepository;
}

export function getVerifiedAccessPrincipal(
  context: McpRequestContext
): AccessPrincipal | undefined {
  return context.authInfo?.extra?.[VERIFIED_PRINCIPAL_AUTH_INFO_KEY] as
    | AccessPrincipal
    | undefined;
}

const domainEvaluateInputSchema = z.object({
  workspace: z.string(),
  domain: z.string(),
  version: z.string(),
  function: z.string(),
  args: z.unknown(),
}).strict();

type DomainEvaluateInput = z.infer<typeof domainEvaluateInputSchema>;

const domainResourceInputShape = {
  workspace: z.string(),
  domain: z.string(),
  version: z.string(),
};

const domainDescribeInputSchema = z.object({
  ...domainResourceInputShape,
  function: z.string().optional(),
}).strict();

const domainValidateInputSchema = z.object(domainResourceInputShape).strict();

type DomainDescribeInput = z.infer<typeof domainDescribeInputSchema>;
type DomainValidateInput = z.infer<typeof domainValidateInputSchema>;

type DomainEvaluateStatus = 'resolved' | 'unresolved' | 'ambiguous' | 'conflict' | 'error';

interface DomainEvaluateError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly ruleIds?: readonly string[];
}

export interface DomainEvaluateResult {
  readonly status: DomainEvaluateStatus;
  readonly decision?: 'allow' | 'deny';
  readonly value: boolean | null;
  readonly workspace: string;
  readonly domain: string;
  readonly version: string;
  readonly function: string;
  readonly matchedRuleIds: readonly string[];
  readonly unresolvedPaths: readonly string[];
  readonly errors: readonly DomainEvaluateError[];
  readonly trace: readonly unknown[];
  readonly provenance: DomainProvenance;
}

export interface DomainFunctionSchema {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly DomainInputDefinition[];
}

interface DomainResourceIdentity {
  readonly workspace: string;
  readonly domain: string;
  readonly version: string;
}

interface DomainResourceError {
  readonly status: 'error';
  readonly ok: false;
  readonly workspace: string;
  readonly domain: string;
  readonly version: string;
  readonly errors: readonly DomainEvaluateError[];
}

type LoadedDomainVersion =
  | { readonly ok: true; readonly input: DomainResourceIdentity; readonly record: DomainVersionRecord }
  | { readonly ok: false; readonly result: DomainResourceError };

export interface DomainDescribeResult {
  readonly status: 'ok' | 'error';
  readonly ok: boolean;
  readonly workspace: string;
  readonly domain: string;
  readonly version: string;
  readonly contractVersion?: string;
  readonly kind?: string;
  readonly functions?: readonly DomainFunctionSchema[];
  readonly function?: DomainFunctionSchema;
  readonly errors: readonly DomainEvaluateError[];
}

export interface DomainValidateResult {
  readonly status: 'valid' | 'invalid' | 'error';
  readonly ok: boolean;
  readonly valid: boolean;
  readonly workspace: string;
  readonly domain: string;
  readonly version: string;
  readonly contractVersion?: string;
  readonly errors: readonly DomainParseError[] | readonly DomainEvaluateError[];
  readonly error?: DomainParseError;
}

function emptyProvenance(): DomainProvenance {
  return {
    fixtureId: 'evaluation',
    functionId: '',
    policyId: '',
    inputPaths: [],
    ruleIds: [],
  };
}

function errorResult(
  input: Partial<DomainEvaluateInput>,
  code: string,
  message: string,
  path?: string,
): DomainEvaluateResult {
  return {
    status: 'error',
    value: null,
    workspace: input.workspace ?? '',
    domain: input.domain ?? '',
    version: input.version ?? '',
    function: input.function ?? '',
    matchedRuleIds: [],
    unresolvedPaths: [],
    errors: [{ code, message, ...(path === undefined ? {} : { path }) }],
    trace: [],
    provenance: emptyProvenance(),
  };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function resourceError(
  input: Partial<DomainResourceIdentity>,
  code: string,
  message: string,
  path?: string,
): DomainResourceError {
  return {
    status: 'error',
    ok: false,
    workspace: input.workspace ?? '',
    domain: input.domain ?? '',
    version: input.version ?? '',
    errors: [{ code, message, ...(path === undefined ? {} : { path }) }],
  };
}

function functionSchema(domainFunction: DomainFunction): DomainFunctionSchema {
  return Object.freeze({
    id: domainFunction.id,
    name: domainFunction.name,
    description: domainFunction.description,
    inputs: Object.freeze(domainFunction.inputs.map((input) => Object.freeze({
      path: input.path,
      type: input.type,
      required: input.required,
    }))),
  });
}

async function loadStoredDomainVersion(
  input: DomainResourceIdentity,
  principal: AccessPrincipal,
  env: Env,
  dependencies: McpRequestDependencies,
): Promise<LoadedDomainVersion> {
  if (!isIdentifier(input.workspace)) {
    return { ok: false, result: resourceError(input, 'INVALID_ARGS', 'workspace must be a non-empty, trimmed string.', 'workspace') };
  }
  if (!isIdentifier(input.domain)) {
    return { ok: false, result: resourceError(input, 'INVALID_ARGS', 'domain must be a non-empty, trimmed string.', 'domain') };
  }
  if (!isIdentifier(input.version)) {
    return { ok: false, result: resourceError(input, 'INVALID_VERSION', 'version must be a non-empty, trimmed string.', 'version') };
  }

  try {
    const repository = dependencies.workspaceRepository ?? productionWorkspaceRepository(env);
    const workspace = await repository.forPrincipal(principal, input.workspace);
    const record = await workspace.loadVersion({
      domainId: input.domain,
      versionId: input.version,
    });
    if (record === null) {
      return { ok: false, result: resourceError(input, PUBLIC_RESOURCE_NOT_FOUND, 'Resource not found.') };
    }
    if (
      record.workspaceId !== input.workspace
      || record.domainId !== input.domain
      || record.versionId !== input.version
    ) {
      return { ok: false, result: resourceError(input, PUBLIC_RESOURCE_NOT_FOUND, 'Resource not found.') };
    }
    return { ok: true, input, record };
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return { ok: false, result: resourceError(input, PUBLIC_RESOURCE_NOT_FOUND, 'Resource not found.') };
    }
    if (error instanceof DomainRepositoryError) {
      if (error.code === 'INVALID_IDENTIFIER') {
        return { ok: false, result: resourceError(input, 'INVALID_VERSION', 'version is invalid.', 'version') };
      }
      if (error.code === 'CORRUPT_VERSION') {
        return { ok: false, result: resourceError(input, 'STORAGE_FAILURE', 'Stored domain version is invalid.') };
      }
      return { ok: false, result: resourceError(input, 'STORAGE_FAILURE', 'Stored domain version could not be loaded.') };
    }
    return { ok: false, result: resourceError(input, 'STORAGE_FAILURE', 'Stored domain version could not be loaded.') };
  }
}

async function describeStoredDomain(
  input: DomainDescribeInput,
  principal: AccessPrincipal,
  env: Env,
  dependencies: McpRequestDependencies,
): Promise<DomainDescribeResult> {
  if (input.function !== undefined && !isIdentifier(input.function)) {
    return {
      ...resourceError(input, 'INVALID_FUNCTION', 'function must be a non-empty, trimmed string.', 'function'),
    };
  }

  const loaded = await loadStoredDomainVersion(input, principal, env, dependencies);
  if (!loaded.ok) return loaded.result;

  const parsed = parseDomain(loaded.record.model);
  if (!parsed.ok) {
    return {
      ...resourceError(input, 'STORAGE_FAILURE', 'Stored domain version is invalid.'),
    };
  }
  const functions = Object.freeze(parsed.value.functions.map(functionSchema));
  if (input.function === undefined) {
    return {
      status: 'ok',
      ok: true,
      workspace: input.workspace,
      domain: input.domain,
      version: input.version,
      contractVersion: parsed.value.contractVersion,
      kind: parsed.value.kind,
      functions,
      errors: [],
    };
  }

  const matches = parsed.value.functions.filter((domainFunction) => domainFunction.name === input.function);
  if (matches.length === 0) {
    return resourceError(input, 'INVALID_FUNCTION', "Function '" + input.function + "' is not declared.", 'function');
  }
  if (matches.length > 1) {
    return resourceError(input, 'INVALID_FUNCTION', "Function name '" + input.function + "' is ambiguous.", 'function');
  }
  const selectedFunction = functionSchema(matches[0]);
  return {
    status: 'ok',
    ok: true,
    workspace: input.workspace,
    domain: input.domain,
    version: input.version,
    contractVersion: parsed.value.contractVersion,
    kind: parsed.value.kind,
    functions: Object.freeze([selectedFunction]),
    function: selectedFunction,
    errors: [],
  };
}

async function validateStoredDomain(
  input: DomainValidateInput,
  principal: AccessPrincipal,
  env: Env,
  dependencies: McpRequestDependencies,
): Promise<DomainValidateResult> {
  const loaded = await loadStoredDomainVersion(input, principal, env, dependencies);
  if (!loaded.ok) {
    return {
      ...loaded.result,
      valid: false,
    };
  }

  const parsed = parseDomain(loaded.record.model);
  if (!parsed.ok) {
    return {
      status: 'invalid',
      ok: false,
      valid: false,
      workspace: input.workspace,
      domain: input.domain,
      version: input.version,
      errors: parsed.errors,
      error: parsed.error,
    };
  }
  return {
    status: 'valid',
    ok: true,
    valid: true,
    workspace: input.workspace,
    domain: input.domain,
    version: input.version,
    contractVersion: parsed.value.contractVersion,
    errors: [],
  };
}

function publicStatus(status: DomainEvaluateResult['status'] | 'allow' | 'deny', errors: readonly DomainEvaluateError[]): DomainEvaluateStatus {
  if (status === 'allow' || status === 'deny') return 'resolved';
  if (status === 'error' && errors.some((item) => item.code === 'INVALID_FUNCTION' && item.message.includes('ambiguous'))) {
    return 'ambiguous';
  }
  return status;
}

function evaluationResult(
  input: DomainEvaluateInput,
  result: ReturnType<typeof evaluate>,
): DomainEvaluateResult {
  const errors = result.errors.map((item) => ({
    code: item.code,
    message: item.message,
    ...(item.path === undefined ? {} : { path: item.path }),
    ...(item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
    ...(item.ruleIds === undefined ? {} : { ruleIds: item.ruleIds }),
  }));
  const status = publicStatus(result.status, errors);
  return {
    status,
    ...(result.status === 'allow' || result.status === 'deny' ? { decision: result.status } : {}),
    value: result.value,
    workspace: input.workspace,
    domain: input.domain,
    version: input.version,
    function: input.function,
    matchedRuleIds: result.matchedRuleIds,
    unresolvedPaths: result.unresolvedPaths,
    errors,
    trace: result.trace,
    provenance: result.provenance,
  };
}

function productionWorkspaceRepository(env: Env): McpWorkspaceRepository {
  if (env.DB === undefined) {
    throw new Error('D1 database is not configured');
  }
  return new AuthWorkspaceRepositoryAdapter(
    new D1WorkspaceMembershipRepository(env.DB),
    createDomainRepository(env.DB),
  );
}

async function evaluateStoredDomain(
  input: DomainEvaluateInput,
  principal: AccessPrincipal,
  env: Env,
  dependencies: McpRequestDependencies,
): Promise<DomainEvaluateResult> {
  if (!isIdentifier(input.workspace)) {
    return errorResult(input, 'INVALID_ARGS', 'workspace must be a non-empty, trimmed string.', 'workspace');
  }
  if (!isIdentifier(input.domain)) {
    return errorResult(input, 'INVALID_ARGS', 'domain must be a non-empty, trimmed string.', 'domain');
  }
  if (!isIdentifier(input.version)) {
    return errorResult(input, 'INVALID_VERSION', 'version must be a non-empty, trimmed string.', 'version');
  }
  if (!isIdentifier(input.function)) {
    return errorResult(input, 'INVALID_FUNCTION', 'function must be a non-empty, trimmed string.', 'function');
  }

  try {
    const repository = dependencies.workspaceRepository ?? productionWorkspaceRepository(env);
    const workspace = await repository.forPrincipal(principal, input.workspace);
    const record = await workspace.loadVersion({
      domainId: input.domain,
      versionId: input.version,
    });
    if (
      record.workspaceId !== input.workspace
      || record.domainId !== input.domain
      || record.versionId !== input.version
    ) {
      return errorResult(input, PUBLIC_RESOURCE_NOT_FOUND, 'Resource not found.');
    }
    return evaluationResult(input, evaluate(record.model, input.function, input.args));
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return errorResult(input, PUBLIC_RESOURCE_NOT_FOUND, 'Resource not found.');
    }
    if (error instanceof DomainRepositoryError) {
      if (error.code === 'INVALID_IDENTIFIER') {
        return errorResult(input, 'INVALID_VERSION', 'version is invalid.', 'version');
      }
      if (error.code === 'CORRUPT_VERSION') {
        return errorResult(input, 'STORAGE_FAILURE', 'Stored domain version is invalid.');
      }
      return errorResult(input, 'STORAGE_FAILURE', 'Stored domain version could not be loaded.');
    }
    return errorResult(input, 'STORAGE_FAILURE', 'Stored domain version could not be loaded.');
  }
}

function createMcpServer(
  context: McpRequestContext,
  env: Env,
  dependencies: McpRequestDependencies,
): McpServer {
  const principal = getVerifiedAccessPrincipal(context);
  if (principal === undefined) {
    // This should be unreachable because authentication happens before the
    // SDK handler is called. Keep the application boundary fail closed too.
    throw new Error('MCP request has no verified principal');
  }

  const server = new McpServer({
    name: 'invariant-mcp',
    version: '0.0.1',
  });

  server.registerTool(
    'domain.ping',
    {
      description: 'ドメインコアの疎通および健全性を確認',
    },
    async () => {
      // The verified principal is available to every request-scoped tool via
      // this closure without trusting caller-provided identity headers.
      void principal;
      const result = ping();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  server.registerTool(
    'domain.evaluate',
    {
      description: 'Evaluate an explicitly selected authorized stored domain version.',
      inputSchema: domainEvaluateInputSchema,
    },
    async (input: DomainEvaluateInput) => {
      const result = await evaluateStoredDomain(input, principal, env, dependencies);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: result.status === 'error',
      };
    },
  );

  server.registerTool(
    'domain.describe',
    {
      description: 'Describe the stored function and input type schemas for an explicitly selected domain version.',
      inputSchema: domainDescribeInputSchema,
    },
    async (input: DomainDescribeInput) => {
      const result = await describeStoredDomain(input, principal, env, dependencies);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: result.status === 'error',
      };
    },
  );

  server.registerTool(
    'domain.validate',
    {
      description: 'Validate an explicitly selected authorized stored domain version.',
      inputSchema: domainValidateInputSchema,
    },
    async (input: DomainValidateInput) => {
      const result = await validateStoredDomain(input, principal, env, dependencies);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: result.status !== 'valid',
      };
    },
  );

  return server;
}

function authenticationFailureResponse(corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Unauthorized',
      },
    }),
    {
      status: 401,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      },
    }
  );
}

function createMcpAuthInfo(request: Request, principal: AccessPrincipal): AuthInfo {
  return {
    // The MCP SDK requires the token field for its standard auth context. The
    // raw token is kept request-scoped and is never returned in an MCP result.
    token: request.headers.get(CF_ACCESS_JWT_ASSERTION_HEADER) ?? 'test-bypass',
    clientId: principal.subject,
    scopes: [],
    expiresAt: principal.expiresAt,
    extra: {
      [VERIFIED_PRINCIPAL_AUTH_INFO_KEY]: principal,
    },
  };
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  dependencies: McpRequestDependencies = {}
): Promise<Response> {
  // DNS Rebinding 対策: Origin ヘッダーの検証 (不正な場合は 403 を返却)
  const originRejection = originValidationResponse(request, ALLOWED_ORIGIN_HOSTNAMES);
  if (originRejection) {
    return originRejection;
  }

  const origin = request.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  // CORS プリフライトリクエストの処理
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  let principal: AccessPrincipal;
  try {
    // Injected providers are a test seam only. A production request cannot
    // replace the configured Cloudflare Access provider at runtime.
    if (dependencies.accessVerifier !== undefined && env.INVARIANT_ENVIRONMENT !== 'test') {
      throw new Error('injected verifier is test-only');
    }
    if (dependencies.workspaceRepository !== undefined && env.INVARIANT_ENVIRONMENT !== 'test') {
      throw new Error('injected workspace repository is test-only');
    }
    const verifier = dependencies.accessVerifier ?? createAccessTokenVerifier(env);
    principal = await verifier.verify(request);
  } catch {
    // Do not expose whether the failure was a missing token, bad claim, bad
    // signature, JWKS outage, or invalid Worker configuration.
    return authenticationFailureResponse(corsHeaders);
  }

  const mcpHandler = createMcpHandler(
    (context) => createMcpServer(context, env, dependencies),
    { legacy: 'reject' },
  );
  const response = await mcpHandler.fetch(request, {
    authInfo: createMcpAuthInfo(request, principal),
  });

  // レスポンスに CORS ヘッダーを付与
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
