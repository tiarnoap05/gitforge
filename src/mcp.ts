// The MCP surface: JSON-RPC 2.0 over Streamable HTTP, plain JSON answers,
// both protocol eras. `server/discover` answers the modern revision; the
// `initialize` handshake answers the legacy one. The tools act on the same
// store as REST and GraphQL, so an object created over MCP is the same
// object over REST.
//
// The tools list is one frozen constant: two tools/list answers hold the
// same tools array byte for byte. A tool failure is a result with
// isError:true (HTTP 200), never a JSON-RPC error and never an HTTP 500;
// only unknown methods and unknown tools are JSON-RPC errors.

import { VIEWER } from './identity.ts';
import { headerValue, isRecord, jsonError, jsonResponse } from './http.ts';
import type { ForgeRequest, ForgeResponse } from './http.ts';
import { issueProjection, pullProjection, repoProjection } from './rest.ts';
import { Store, StoreError } from './store.ts';
import type { RepoRecord } from './store.ts';

export interface McpContext {
  readonly store: Store;
  readonly token: string;
}

const SERVER_INFO = { name: 'gitforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
    readonly required: readonly string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>,
  required: readonly string[],
): McpToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

/** The one tools list, frozen: every tools/list answer serializes from this. */
const TOOLS: readonly McpToolDefinition[] = Object.freeze([
  tool(
    'create_repo',
    'Create a repository owned by the token owner.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'The repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Read one repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository.',
    {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'The issue state filter: open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from one branch into another.',
    {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Squash-merge a pull request.',
    {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

const TOOLS_BY_NAME = new Map(TOOLS.map((definition) => [definition.name, definition]));

// ------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number | null;

interface RpcRequest {
  readonly id: JsonRpcId | undefined;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

// ------------------------------------------------------------- tool execution

class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolFailure';
  }
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new ToolFailure(`missing required argument: ${name}`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function requireNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new ToolFailure(`missing required argument: ${name}`);
}

function requireRepo(store: Store, owner: string, repoName: string): RepoRecord {
  if (owner !== VIEWER.login) throw new ToolFailure(`repository ${owner}/${repoName} does not exist`);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) throw new ToolFailure(`repository ${owner}/${repoName} does not exist`);
  return repo;
}

function executeTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = requireString(args, 'name');
        const created = store.createRepo(VIEWER.login, repoName, {
          description: optionalString(args, 'description'),
          isPrivate: args.private === true,
        });
        if (created === null) throw new ToolFailure(`name already exists on this account: ${repoName}`);
        return toolResult(repoProjection(created));
      }
      case 'get_repo': {
        const repo = requireRepo(store, requireString(args, 'owner'), requireString(args, 'repo'));
        return toolResult(repoProjection(repo));
      }
      case 'create_issue': {
        const repo = requireRepo(store, requireString(args, 'owner'), requireString(args, 'repo'));
        const issue = store.createIssue(repo, { title: requireString(args, 'title'), body: optionalString(args, 'body') });
        return toolResult(issueProjection(store, repo, issue));
      }
      case 'list_issues': {
        const repo = requireRepo(store, requireString(args, 'owner'), requireString(args, 'repo'));
        const stateRaw = args.state;
        const state = stateRaw === 'all' ? 'all' : stateRaw === 'closed' ? 'closed' : 'open';
        const issues = store.listIssues(repo, { state, sort: 'created', direction: 'desc' });
        return toolResult(issues.map((issue) => issueProjection(store, repo, issue)));
      }
      case 'create_pull_request': {
        const repo = requireRepo(store, requireString(args, 'owner'), requireString(args, 'repo'));
        const pull = store.createPull(repo, {
          title: requireString(args, 'title'),
          body: optionalString(args, 'body'),
          head: requireString(args, 'head'),
          base: requireString(args, 'base'),
        });
        return toolResult(pullProjection(store, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = requireRepo(store, requireString(args, 'owner'), requireString(args, 'repo'));
        const number = requireNumber(args, 'pull_number');
        const pull = store.getPull(repo, number);
        if (pull === undefined) throw new ToolFailure(`pull request #${number} does not exist`);
        store.mergePull(repo, pull);
        return toolResult(pullProjection(store, repo, pull));
      }
      default:
        throw new ToolFailure(`unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof ToolFailure) return toolError(err.message);
    if (err instanceof StoreError) return toolError(err.message);
    throw err;
  }
}

// ------------------------------------------------------------- the dispatcher

function dispatch(request: RpcRequest, store: Store): Record<string, unknown> | null {
  const id = request.id ?? null;
  switch (request.method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const offered = request.params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: typeof offered === 'string' && offered !== '' ? offered : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = request.params.name;
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, -32602, 'a tool name is required');
      }
      if (!TOOLS_BY_NAME.has(name)) {
        return rpcError(id, -32601, `unknown tool: ${name}`);
      }
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      try {
        return rpcResult(id, executeTool(store, name, args));
      } catch (err) {
        console.error('mcp tool error:', err);
        return rpcError(id, -32603, 'Internal error');
      }
    }
    default:
      if (request.method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `Method not found: ${request.method}`);
  }
}

function parseRpcRequest(value: unknown): RpcRequest | null {
  if (!isRecord(value)) return null;
  if (typeof value.method !== 'string' || value.method === '') return null;
  const id = value.id;
  const params = isRecord(value.params) ? value.params : {};
  return {
    id: typeof id === 'string' || typeof id === 'number' ? id : undefined,
    method: value.method,
    params,
  };
}

export function handleMcp(request: ForgeRequest, ctx: McpContext): ForgeResponse | null {
  if (request.pathname !== '/mcp') return null;
  if (request.method !== 'POST') return jsonError(404, 'Not Found');
  if (ctx.token !== '') {
    const auth = headerValue(request.headers, 'authorization');
    if (auth !== `Bearer ${ctx.token}`) return jsonError(401, 'Bad credentials');
  }
  let parsed: unknown;
  try {
    parsed = request.body.length === 0 ? null : (JSON.parse(request.body.toString('utf8')) as unknown);
  } catch {
    return jsonResponse(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const entry of parsed) {
      const rpc = parseRpcRequest(entry);
      if (rpc === null) {
        results.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      if (rpc.id === undefined) {
        dispatch(rpc, ctx.store);
        continue;
      }
      results.push(dispatch(rpc, ctx.store) ?? rpcResult(null, {}));
    }
    return jsonResponse(200, results);
  }
  const rpc = parseRpcRequest(parsed);
  if (rpc === null) {
    return jsonResponse(200, rpcError(null, -32600, 'Invalid Request'));
  }
  if (rpc.id === undefined) {
    // A notification: no JSON-RPC answer, HTTP 202 with an empty body.
    dispatch(rpc, ctx.store);
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }
  const answer = dispatch(rpc, ctx.store);
  return jsonResponse(200, answer ?? rpcResult(rpc.id, {}));
}
