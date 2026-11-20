// The REST v3 surface: every /api/v3 route the suite speaks, over the one
// shared store. Every reply is JSON with an X-GitHub-Request-Id (added by the
// router), errors carry a string `message`, and a repository under any owner
// but the token's is a 404, never a 403.
//
// The issue read is the benchmark's hot path (2,000 sequential GETs of one
// issue), so a serialized issue body is cached per issue version and reused
// until the issue changes; only the request-id header varies between reads.

import { VIEWER } from './identity.ts';
import {
  headerValue,
  isRecord,
  jsonError,
  jsonResponse,
  linkHeader,
  pageParams,
  paginate,
  parseJsonBody,
  pathSegments,
  stringField,
} from './http.ts';
import type { ForgeRequest, ForgeResponse } from './http.ts';
import { parseCommit } from './objects.ts';
import { Store, StoreError } from './store.ts';
import type { CommentRecord, IssueRecord, PullRecord, RepoRecord } from './store.ts';

export interface RestContext {
  readonly store: Store;
  readonly token: string;
}

const OAUTH_SCOPES = 'repo, read:org';

// ---------------------------------------------------------------- projections

function userProjection(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    html_url: `https://github.com/${VIEWER.login}`,
    url: `https://api.github.com/users/${VIEWER.login}`,
  };
}

function ownerProjection(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', avatar_url: '', html_url: `https://github.com/${VIEWER.login}` };
}

export function repoProjection(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: ownerProjection(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelProjection(repo: RepoRecord, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
}

export function issueProjection(store: Store, repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelProjection(repo, name)),
    user: ownerProjection(),
    assignees: [],
    locked: false,
    comments: store.listComments(repo, issue.number).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** A pull request read through the issues API: the issue shape plus its pull-request marker. */
function pullAsIssueProjection(store: Store, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: ownerProjection(),
    assignees: [],
    locked: false,
    comments: store.listComments(repo, pull.number).length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    pull_request: { url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` },
  };
}

export function pullProjection(store: Store, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const headSha = store.pullHeadSha(repo, pull);
  const baseSha = store.pullBaseSha(repo, pull) ?? '';
  const files = store.pullFiles(repo, pull);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return {
    id: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.mergeable(repo, pull) === 'MERGEABLE' : false,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, user: ownerProjection(), repo: repoProjection(repo) },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, user: ownerProjection(), repo: repoProjection(repo) },
    user: ownerProjection(),
    assignees: [],
    additions,
    deletions,
    changed_files: files.length,
    commits: 1,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentProjection(repo: RepoRecord, comment: CommentRecord): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: ownerProjection(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${comment.subjectNumber}#issuecomment-${comment.id}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

// ---------------------------------------------------------------- helpers

/** The serialized issue bodies, keyed by repo id + number, valid for one issue version. */
const issueJsonCache = new Map<string, { version: number; body: Buffer }>();

function cachedIssueJson(store: Store, repo: RepoRecord, issue: IssueRecord): Buffer {
  const key = `${repo.id}:${issue.number}`;
  const cached = issueJsonCache.get(key);
  if (cached !== undefined && cached.version === issue.version) return cached.body;
  const body = Buffer.from(JSON.stringify(issueProjection(store, repo, issue)), 'utf8');
  if (issueJsonCache.size > 10_000) issueJsonCache.clear();
  issueJsonCache.set(key, { version: issue.version, body });
  return body;
}

function readBody(request: ForgeRequest): unknown {
  try {
    return parseJsonBody(request);
  } catch {
    throw new StoreError(400, 'Problems parsing JSON');
  }
}

function requireFields(body: unknown, fields: readonly string[]): void {
  if (!isRecord(body)) throw new StoreError(422, 'the request body must be a JSON object');
  for (const field of fields) {
    const value = body[field];
    if (typeof value !== 'string' || value === '') throw new StoreError(422, `the ${field} field is required`);
  }
}

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const value = Number.parseInt(segment, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Parse a git ident line ("Name <email> ts tz") into its parts. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  const name = match[1] as string;
  const email = match[2] as string;
  const seconds = Number.parseInt(match[3] as string, 10);
  return { name, email, date: new Date(seconds * 1000).toISOString() };
}

/** Strip exactly one trailing newline, the way GitHub shows a commit message. */
function displayMessage(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

function stripOwnerPrefix(value: string, owner: string): string {
  const prefix = `${owner}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

// ---------------------------------------------------------------- the router

export function handleRest(request: ForgeRequest, ctx: RestContext): ForgeResponse | null {
  const pathname = request.pathname;
  let rest: string;
  if (pathname === '/api/v3') rest = '';
  else if (pathname.startsWith('/api/v3/')) rest = pathname.slice('/api/v3/'.length);
  else return null;

  const segments = pathSegments(rest === '' ? '/' : `/${rest}`);
  const method = request.method;

  try {
    // The one open route: GET /api/v3/ answers without a token.
    if (segments.length === 0) {
      if (method !== 'GET') return jsonError(404, 'Not Found');
      return jsonResponse(
        200,
        {
          current_user_url: 'https://api.github.com/user',
          repository_url: 'https://api.github.com/repos/{owner}/{repo}',
          user_url: 'https://api.github.com/users/{user}',
        },
        { 'X-OAuth-Scopes': OAUTH_SCOPES },
      );
    }

    if (ctx.token !== '') {
      const auth = headerValue(request.headers, 'authorization');
      if (auth !== `Bearer ${ctx.token}`) return jsonError(401, 'Bad credentials');
    }

    const [head, ...tail] = segments as [string, ...string[]];
    if (head === 'meta') {
      if (method !== 'GET' || tail.length !== 0) return jsonError(404, 'Not Found');
      return jsonResponse(200, {
        installed_version: 'gitforge-1.0.0',
        verifiable_password_authentication: true,
        ssh_key_fingerprints: {},
        hooks: [],
        packages: [],
        domains: {},
      });
    }
    if (head === 'user') return handleUser(request, ctx, tail);
    if (head === 'repos') return handleRepos(request, ctx, tail);
    return jsonError(404, 'Not Found');
  } catch (err) {
    if (err instanceof StoreError) return jsonError(err.status, err.message);
    console.error('rest handler error:', err);
    return jsonError(500, 'Internal Server Error');
  }
}

function handleUser(request: ForgeRequest, ctx: RestContext, tail: string[]): ForgeResponse {
  const { store } = ctx;
  const method = request.method;
  if (tail.length === 0) {
    if (method !== 'GET') return jsonError(404, 'Not Found');
    return jsonResponse(200, userProjection());
  }
  if (tail[0] === 'repos' && tail.length === 1) {
    if (method === 'GET') {
      const params = pageParams(request.query);
      const paged = paginate(store.reposOf(VIEWER.login), params);
      const headers: Record<string, string> = {};
      const link = linkHeader(request, paged);
      if (link !== undefined) headers.link = link;
      return jsonResponse(200, paged.items.map(repoProjection), headers);
    }
    if (method === 'POST') {
      const body = readBody(request);
      const name = stringField(body, 'name');
      if (name === undefined || name === '' || name.includes('/') || name.length > 100) {
        throw new StoreError(422, 'the name field is required');
      }
      const created = store.createRepo(VIEWER.login, name, {
        description: stringField(body, 'description') ?? '',
        isPrivate: isRecord(body) && body.private === true,
      });
      if (created === null) throw new StoreError(422, 'name already exists on this account');
      return jsonResponse(201, repoProjection(created));
    }
  }
  return jsonError(404, 'Not Found');
}

function handleRepos(request: ForgeRequest, ctx: RestContext, tail: string[]): ForgeResponse {
  const { store } = ctx;
  const method = request.method;
  if (tail.length < 2) return jsonError(404, 'Not Found');
  const [owner, repoName, ...rest] = tail as [string, string, ...string[]];
  // A repository under any other owner is a 404, never a 403.
  if (owner !== VIEWER.login) return jsonError(404, 'Not Found');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonError(404, 'Not Found');

  if (rest.length === 0) {
    if (method === 'GET') return jsonResponse(200, repoProjection(repo));
    if (method === 'PATCH') {
      const body = readBody(request);
      if (isRecord(body)) {
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      }
      store.touch(repo);
      return jsonResponse(200, repoProjection(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.alloc(0) };
    }
    return jsonError(404, 'Not Found');
  }

  const [section, ...args] = rest as [string, ...string[]];
  switch (section) {
    case 'branches':
      return handleBranches(request, ctx, repo, args);
    case 'commits':
      return handleCommits(request, ctx, repo, args);
    case 'contents':
      return handleContents(request, ctx, repo, args);
    case 'git':
      return handleGitData(request, ctx, repo, args);
    case 'labels':
      return handleLabels(request, ctx, repo, args);
    case 'issues':
      return handleIssues(request, ctx, repo, args);
    case 'pulls':
      return handlePulls(request, ctx, repo, args);
    default:
      return jsonError(404, 'Not Found');
  }
}

function handleBranches(request: ForgeRequest, ctx: RestContext, repo: RepoRecord, args: string[]): ForgeResponse {
  const { store } = ctx;
  if (request.method !== 'GET') return jsonError(404, 'Not Found');
  if (args.length === 0) {
    const params = pageParams(request.query);
    const branches = store.listBranches(repo).map((branch) => ({
      name: branch.name,
      commit: { sha: branch.sha, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${branch.sha}` },
      protected: false,
    }));
    const paged = paginate(branches, params);
    const headers: Record<string, string> = {};
    const link = linkHeader(request, paged);
    if (link !== undefined) headers.link = link;
    return jsonResponse(200, paged.items, headers);
  }
  const branch = args.join('/');
  const sha = store.getRef(repo, `refs/heads/${branch}`);
  if (sha === undefined) return jsonError(404, 'Not Found');
  return jsonResponse(200, {
    name: branch,
    commit: { sha, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  });
}

function handleCommits(request: ForgeRequest, ctx: RestContext, repo: RepoRecord, args: string[]): ForgeResponse {
  const { store } = ctx;
  if (request.method !== 'GET' || args.length !== 0) return jsonError(404, 'Not Found');
  if (repo.refs.size === 0) throw new StoreError(409, 'Git Repository is empty.');
  const ref = request.query.get('sha') ?? repo.defaultBranch;
  const tip = store.resolveRef(repo, ref);
  if (tip === undefined) return jsonError(404, 'Not Found');
  const params = pageParams(request.query);
  const walked = store.walkCommits(repo, tip, 100);
  const entries = walked.map((entry) => {
    const object = repo.objects.get(entry.sha);
    const commit = object === undefined ? null : parseCommit(object.data);
    const author = commit === null ? { name: '', email: '', date: '' } : parseIdent(commit.author);
    const committer = commit === null ? { name: '', email: '', date: '' } : parseIdent(commit.committer);
    return {
      sha: entry.sha,
      commit: {
        message: displayMessage(entry.message),
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: committer.name, email: committer.email, date: committer.date },
        tree: { sha: entry.tree },
      },
      author: ownerProjection(),
      committer: ownerProjection(),
      parents: entry.parents.map((sha) => ({ sha })),
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${entry.sha}`,
      url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${entry.sha}`,
    };
  });
  const paged = paginate(entries, params);
  const headers: Record<string, string> = {};
  const link = linkHeader(request, paged);
  if (link !== undefined) headers.link = link;
  return jsonResponse(200, paged.items, headers);
}

function handleContents(request: ForgeRequest, ctx: RestContext, repo: RepoRecord, args: string[]): ForgeResponse {
  const { store } = ctx;
  const method = request.method;
  const path = args.join('/');
  if (method === 'GET') {
    const ref = request.query.get('ref') ?? repo.defaultBranch;
    const found = store.readPath(repo, ref, path);
    if (found === null) return jsonError(404, 'Not Found');
    if (found.kind === 'file') {
      const name = path.split('/').pop() ?? path;
      return jsonResponse(200, {
        type: 'file',
        encoding: 'base64',
        size: found.size,
        name,
        path,
        sha: found.oid,
        content: found.data.toString('base64'),
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
      });
    }
    return jsonResponse(
      200,
      found.entries.map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
        size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/${ref}/${entry.path}`,
      })),
    );
  }
  if (method === 'PUT') {
    const body = readBody(request);
    requireFields(body, ['message', 'content']);
    const content = stringField(body, 'content') as string;
    const message = stringField(body, 'message') as string;
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const sha = stringField(body, 'sha');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    } catch {
      throw new StoreError(422, 'the content field is not valid base64');
    }
    const result = store.commitFile(repo, { branch, path, content: bytes, message, sha });
    const name = path.split('/').pop() ?? path;
    return jsonResponse(result.created ? 201 : 200, {
      content: { name, path, sha: result.blobSha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') },
      commit: { sha: result.commitSha, message },
    });
  }
  if (method === 'DELETE') {
    const body = readBody(request);
    requireFields(body, ['message', 'sha']);
    const message = stringField(body, 'message') as string;
    const sha = stringField(body, 'sha') as string;
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const result = store.deleteFile(repo, { branch, path, message, sha });
    return jsonResponse(200, { commit: { sha: result.commitSha, message }, content: null });
  }
  return jsonError(404, 'Not Found');
}

function handleGitData(request: ForgeRequest, ctx: RestContext, repo: RepoRecord, args: string[]): ForgeResponse {
  const { store } = ctx;
  const method = request.method;
  if (args[0] !== 'refs') return jsonError(404, 'Not Found');
  if (method === 'POST' && args.length === 1) {
    const body = readBody(request);
    requireFields(body, ['ref', 'sha']);
    const ref = stringField(body, 'ref') as string;
    const sha = stringField(body, 'sha') as string;
    if (!ref.startsWith('refs/')) throw new StoreError(422, 'the ref field must start with refs/');
    if (!/^[0-9a-f]{40}$/.test(sha) || store.getObject(repo, sha) === undefined) {
      throw new StoreError(422, 'the sha field must name an object in the repository');
    }
    if (store.getRef(repo, ref) !== undefined) throw new StoreError(422, 'Reference already exists');
    store.setRef(repo, ref, sha);
    const type = store.getObject(repo, sha)?.type ?? 'commit';
    return jsonResponse(201, { ref, object: { sha, type, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${type}s/${sha}` } });
  }
  if (method === 'GET' && args.length >= 2) {
    const ref = `refs/${args.slice(1).join('/')}`;
    const sha = store.getRef(repo, ref);
    if (sha === undefined) return jsonError(404, 'Not Found');
    const type = store.getObject(repo, sha)?.type ?? 'commit';
    return jsonResponse(200, { ref, object: { sha, type, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${type}s/${sha}` } });
  }
  return jsonError(404, 'Not Found');
}

function handleLabels(request: ForgeRequest, ctx: RestContext, repo: RepoRecord, args: string[]): ForgeResponse {
  const { store } = ctx;
  if (args.length !== 0) return jsonError(404, 'Not Found');
  if (request.method === 'GET') {
    return jsonResponse(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
  }
  if (request.method === 'POST') {
    const body = readBody(request);
    const name = stringField(body, 'name');
    if (name === undefined || name === '') throw new StoreError(422, 'the name field is required');
    const created = store.createLabel(repo, name, stringField(body, 'color'), stringField(body, 'description'));
    if (created === null) throw new StoreError(422, 'Label already exists');
    return jsonResponse(201, { name: created.name, color: created.color, description: created.description });
  }
  return jsonError(404, 'Not Found');
}

function handleIssues(request: ForgeRequest, ctx: RestContext, repo: RepoRecord, args: string[]): ForgeResponse {
  const { store } = ctx;
  const method = request.method;
  if (args.length === 0) {
    if (method === 'GET') {
      const stateRaw = request.query.get('state') ?? 'open';
      const state = stateRaw === 'all' ? 'all' : stateRaw === 'closed' ? 'closed' : 'open';
      const sort = request.query.get('sort') === 'updated' ? 'updated' : 'created';
      const direction = request.query.get('direction') === 'asc' ? 'asc' : 'desc';
      const params = pageParams(request.query);
      const paged = paginate(store.listIssues(repo, { state, sort, direction }), params);
      const headers: Record<string, string> = {};
      const link = linkHeader(request, paged);
      if (link !== undefined) headers.link = link;
      return jsonResponse(200, paged.items.map((issue) => issueProjection(store, repo, issue)), headers);
    }
    if (method === 'POST') {
      const body = readBody(request);
      const title = stringField(body, 'title');
      if (title === undefined || title === '') throw new StoreError(422, 'the title field is required');
      const labelsRaw = isRecord(body) && Array.isArray(body.labels) ? body.labels : [];
      const labels: string[] = [];
      for (const entry of labelsRaw) {
        if (typeof entry === 'string') labels.push(entry);
        else if (isRecord(entry) && typeof entry.name === 'string') labels.push(entry.name);
      }
      const issue = store.createIssue(repo, { title, body: stringField(body, 'body') ?? '', labels });
      return jsonResponse(201, issueProjection(store, repo, issue));
    }
    return jsonError(404, 'Not Found');
  }
  const number = parseNumber(args[0] as string);
  if (number === null) return jsonError(404, 'Not Found');
  if (args.length === 1) {
    if (method === 'GET') {
      const issue = store.getIssue(repo, number);
      if (issue !== undefined) {
        return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: cachedIssueJson(store, repo, issue) };
      }
      const pull = store.getPull(repo, number);
      if (pull !== undefined) return jsonResponse(200, pullAsIssueProjection(store, repo, pull));
      return jsonError(404, 'Not Found');
    }
    if (method === 'PATCH') {
      const body = readBody(request);
      const stateRaw = stringField(body, 'state');
      const state = stateRaw === 'closed' ? 'closed' : stateRaw === 'open' ? 'open' : undefined;
      const issue = store.getIssue(repo, number);
      if (issue !== undefined) {
        const patched = store.patchIssue(repo, number, {
          state,
          title: stringField(body, 'title'),
          body: stringField(body, 'body'),
        });
        if (patched === null) return jsonError(404, 'Not Found');
        if (isRecord(body) && Array.isArray(body.labels)) {
          const names: string[] = [];
          for (const entry of body.labels) {
            const name = typeof entry === 'string' ? entry : isRecord(entry) ? stringField(entry, 'name') : undefined;
            if (name === undefined) continue;
            if (!repo.labels.has(name)) throw new StoreError(422, `label ${JSON.stringify(name)} does not exist`);
            names.push(name);
          }
          patched.labels = names;
          patched.version += 1;
          store.touch(repo);
        }
        return jsonResponse(200, issueProjection(store, repo, patched));
      }
      const pull = store.getPull(repo, number);
      if (pull !== undefined) {
        if (state !== undefined) store.patchPullState(repo, number, state);
        return jsonResponse(200, pullAsIssueProjection(store, repo, pull));
      }
      return jsonError(404, 'Not Found');
    }
    return jsonError(404, 'Not Found');
  }
  if (args[1] === 'comments' && args.length === 2) {
    if (store.getSubject(repo, number) === undefined) return jsonError(404, 'Not Found');
    if (method === 'GET') {
      return jsonResponse(200, store.listComments(repo, number).map((comment) => commentProjection(repo, comment)));
    }
    if (method === 'POST') {
      const body = readBody(request);
      const text = stringField(body, 'body');
      if (text === undefined || text === '') throw new StoreError(422, 'the body field is required');
      const comment = store.addComment(repo, number, text);
      if (comment === null) return jsonError(404, 'Not Found');
      return jsonResponse(201, commentProjection(repo, comment));
    }
  }
  return jsonError(404, 'Not Found');
}

function handlePulls(request: ForgeRequest, ctx: RestContext, repo: RepoRecord, args: string[]): ForgeResponse {
  const { store } = ctx;
  const method = request.method;
  if (args.length === 0) {
    if (method === 'GET') {
      const stateRaw = request.query.get('state') ?? 'open';
      const state = stateRaw === 'all' ? 'all' : stateRaw === 'closed' ? 'closed' : 'open';
      const params = pageParams(request.query);
      const paged = paginate(store.listPulls(repo, { state }), params);
      const headers: Record<string, string> = {};
      const link = linkHeader(request, paged);
      if (link !== undefined) headers.link = link;
      return jsonResponse(200, paged.items.map((pull) => pullProjection(store, repo, pull)), headers);
    }
    if (method === 'POST') {
      const body = readBody(request);
      const title = stringField(body, 'title');
      const headRaw = stringField(body, 'head');
      const baseRaw = stringField(body, 'base');
      if (title === undefined || title === '') throw new StoreError(422, 'the title field is required');
      if (headRaw === undefined || headRaw === '') throw new StoreError(422, 'the head field is required');
      if (baseRaw === undefined || baseRaw === '') throw new StoreError(422, 'the base field is required');
      const pull = store.createPull(repo, {
        title,
        body: stringField(body, 'body') ?? '',
        head: stripOwnerPrefix(headRaw, repo.owner),
        base: stripOwnerPrefix(baseRaw, repo.owner),
      });
      return jsonResponse(201, pullProjection(store, repo, pull));
    }
    return jsonError(404, 'Not Found');
  }
  const number = parseNumber(args[0] as string);
  if (number === null) return jsonError(404, 'Not Found');
  const pull = store.getPull(repo, number);
  if (args.length === 1) {
    if (method !== 'GET') return jsonError(404, 'Not Found');
    if (pull === undefined) return jsonError(404, 'Not Found');
    return jsonResponse(200, pullProjection(store, repo, pull));
  }
  if (args[1] === 'files' && args.length === 2) {
    if (method !== 'GET') return jsonError(404, 'Not Found');
    if (pull === undefined) return jsonError(404, 'Not Found');
    const files = store.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    return jsonResponse(200, files);
  }
  if (args[1] === 'merge' && args.length === 2) {
    if (method !== 'PUT') return jsonError(404, 'Not Found');
    if (pull === undefined) return jsonError(404, 'Not Found');
    const body = readBody(request);
    const mergeMethod = stringField(body, 'merge_method');
    if (mergeMethod !== undefined && mergeMethod !== 'squash') {
      throw new StoreError(422, 'only squash merges are supported');
    }
    const result = store.mergePull(repo, pull);
    return jsonResponse(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return jsonError(404, 'Not Found');
}
