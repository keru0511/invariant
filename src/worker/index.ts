import { getDomainMetadata } from '../domain';
import { handleMcpRequest } from './mcp';
import type { Env } from './env';

export type { Env } from './env';

export const handler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/mcp') {
      return handleMcpRequest(request, env);
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
