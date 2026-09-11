import { getDomainMetadata } from '../domain';
import { handleMcpRequest } from './mcp';

export interface Env {
  // Bindings (e.g. KV, D1, environment variables) will be defined here
}

export const handler: ExportedHandler<Env> = {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      return handleMcpRequest(request);
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const domain = getDomainMetadata();
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'invariant',
          domain,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  },
};

export default handler;
