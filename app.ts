// The HTTP server: one store, four surfaces, one deterministic clock. Every
// reply carries a non-empty X-GitHub-Request-Id, including errors and the
// unauthenticated health check. The routing order is the specificity order:
// the health check first, then the fixed paths, then the git paths, then the
// REST tree, and anything else is a JSON 404.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { nextRequestId, parseTrialNow, TrialClock } from './src/identity.ts';
import { handleGit } from './src/git.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { jsonError, jsonResponse } from './src/http.ts';
import type { ForgeRequest, ForgeResponse } from './src/http.ts';
import { Store } from './src/store.ts';

export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const clock = new TrialClock(parseTrialNow(process.env.MAKEFUN_TRIAL_NOW));
  const store = new Store(clock);
  const ctx = { store, token };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let answer: ForgeResponse;
      try {
        const url = new URL(req.url ?? '/', 'http://forge.local');
        const request: ForgeRequest = {
          method: req.method ?? 'GET',
          pathname: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body: Buffer.concat(chunks),
        };
        if (request.method === 'GET' && request.pathname === '/healthz') {
          answer = jsonResponse(200, { ok: true });
        } else {
          answer =
            handleGraphQL(request, ctx) ??
            handleMcp(request, ctx) ??
            handleGit(request, ctx) ??
            handleRest(request, ctx) ??
            jsonError(404, 'Not Found');
        }
      } catch (err) {
        console.error('unhandled request error:', err);
        answer = jsonError(500, 'Internal Server Error');
      }
      const headers: Record<string, string> = { 'x-github-request-id': nextRequestId() };
      for (const [name, value] of Object.entries(answer.headers)) {
        if (typeof value === 'string') headers[name.toLowerCase()] = value;
      }
      if (answer.body.length > 0 && headers['content-type'] === undefined) {
        headers['content-type'] = 'application/json';
      }
      res.writeHead(answer.status, headers);
      res.end(answer.body);
    });
    req.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });
  });
}
