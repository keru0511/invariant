import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const SMOKE_CONTRACT = Object.freeze({
  healthPath: '/health',
  mcpPath: '/mcp',
  mcpMethod: 'tools/call',
  mcpTool: 'domain.ping',
  protocolVersion: '2026-07-28',
  origin: 'http://localhost:5173',
});

export class SmokeError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'SmokeError';
    this.code = code;
  }
}

export function normalizeDeploymentUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SmokeError('usage', 'a deployment URL is required');
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new SmokeError('usage', 'deployment URL must be an absolute http(s) URL', error);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SmokeError('usage', 'deployment URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SmokeError('usage', 'deployment URL must not contain credentials, query parameters, or a fragment');
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function endpointUrl(baseUrl, path) {
  return new URL(path.replace(/^\/+/, ''), `${baseUrl}/`).toString();
}

function smokeRequestBody() {
  return {
    jsonrpc: '2.0',
    id: 'deployment-smoke',
    method: SMOKE_CONTRACT.mcpMethod,
    params: {
      name: SMOKE_CONTRACT.mcpTool,
      arguments: {},
      _meta: {
        'io.modelcontextprotocol/protocolVersion': SMOKE_CONTRACT.protocolVersion,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': {
          name: 'invariant-deployment-smoke',
          version: '1.0.0',
        },
      },
    },
  };
}

async function requestJson(fetchImpl, url, init, label, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new SmokeError(`${label}-invalid-json`, `${label} response was not valid JSON`, error);
    }
    return { response, body };
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw new SmokeError(`${label}-request`, `${label} request failed: ${error.message}`, error);
  } finally {
    clearTimeout(timer);
  }
}

function requireOkResponse(label, result) {
  if (result.response.status !== 200) {
    throw new SmokeError(`${label}-http`, `${label} expected HTTP 200, got ${result.response.status}`);
  }
}

function requireHealthBody(body) {
  if (body?.status !== 'ok' || body?.service !== 'invariant') {
    throw new SmokeError('health-body', 'health response did not contain the invariant ok contract');
  }
}

function readPingText(body) {
  const content = body?.result?.content;
  if (!Array.isArray(content)) return undefined;
  return content.find((item) => item?.type === 'text')?.text;
}

function requirePingBody(body) {
  const text = readPingText(body);
  if (text !== '{"ok":true}') {
    throw new SmokeError('mcp-ping-body', 'MCP domain.ping did not return {"ok":true}');
  }
  return text;
}

export async function runDeploymentSmoke(baseUrl, options = {}) {
  const normalizedBaseUrl = normalizeDeploymentUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  if (typeof fetchImpl !== 'function') {
    throw new SmokeError('usage', 'this Node runtime does not provide fetch');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new SmokeError('usage', 'timeout must be a positive integer in milliseconds');
  }

  const health = await requestJson(
    fetchImpl,
    endpointUrl(normalizedBaseUrl, SMOKE_CONTRACT.healthPath),
    { method: 'GET', headers: { Accept: 'application/json' } },
    'health',
    timeoutMs,
  );
  requireOkResponse('health', health);
  requireHealthBody(health.body);

  const mcpPing = await requestJson(
    fetchImpl,
    endpointUrl(normalizedBaseUrl, SMOKE_CONTRACT.mcpPath),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: SMOKE_CONTRACT.origin,
        'MCP-Protocol-Version': SMOKE_CONTRACT.protocolVersion,
        'Mcp-Method': SMOKE_CONTRACT.mcpMethod,
        'Mcp-Name': SMOKE_CONTRACT.mcpTool,
      },
      body: JSON.stringify(smokeRequestBody()),
    },
    'mcp-ping',
    timeoutMs,
  );
  requireOkResponse('mcp-ping', mcpPing);
  const pingText = requirePingBody(mcpPing.body);

  return {
    ok: true,
    baseUrl: normalizedBaseUrl,
    checks: {
      health: {
        path: SMOKE_CONTRACT.healthPath,
        status: health.response.status,
        observed: { status: health.body.status, service: health.body.service },
      },
      mcpPing: {
        path: SMOKE_CONTRACT.mcpPath,
        status: mcpPing.response.status,
        tool: SMOKE_CONTRACT.mcpTool,
        observed: { text: pingText },
      },
    },
  };
}

function writeJson(writer, value) {
  writer(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  io = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
) {
  const [argument, ...extraArguments] = argv;
  const deploymentUrl = argument ?? env.DEPLOYMENT_URL;
  if (extraArguments.length > 0 || !deploymentUrl) {
    writeJson(io.stderr, { ok: false, error: { code: 'usage', message: 'usage: npm run smoke:deployment -- <deployment-url>' } });
    return 2;
  }

  try {
    const result = await runDeploymentSmoke(deploymentUrl, { fetchImpl });
    writeJson(io.stdout, result);
    return 0;
  } catch (error) {
    writeJson(io.stderr, {
      ok: false,
      error: {
        code: error instanceof SmokeError ? error.code : 'unexpected',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return error instanceof SmokeError && error.code === 'usage' ? 2 : 1;
  }
}

const isMainModule = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  process.exitCode = await main();
}
