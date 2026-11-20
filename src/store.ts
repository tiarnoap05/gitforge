// The forge's in-memory model: every repository, object, ref, label, issue,
// pull request and comment, plus the domain operations the three surfaces
// share (REST, GraphQL, MCP all read and write the same records, so a thing
// created on one surface is the same object on the others).
//
// Nothing here touches the wall clock: every timestamp comes from the trial
// clock, and every id is a counter or a content hash, so a replay of the same
// requests leaves the same state.

import { TrialClock, VIEWER } from './identity.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTreeFromChanges,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './objects.ts';

export type IssueState = 'open' | 'closed';

export interface LabelRecord {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueRecord {
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  readonly author: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Bumped on every mutation of this issue (the REST read cache's key). */
  version: number;
}

export interface PullRecord {
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  /** The head branch's tip when the pull request opened (a fallback if the branch is deleted). */
  readonly headSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly author: string;
  readonly createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CommentRecord {
  readonly id: number;
  readonly subjectNumber: number;
  body: string;
  readonly author: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface RepoRecord {
  /** The numeric database id: a global counter, never reused after a delete. */
  readonly id: number;
  readonly owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects: Map<string, GitObject>;
  /** Full ref names (refs/heads/*, refs/tags/*) to their tips. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: Map<number, IssueRecord>;
  readonly pulls: Map<number, PullRecord>;
  /** Comments keyed by the issue or pull request number they belong to. */
  readonly comments: Map<number, CommentRecord[]>;
  /** The shared issue/pull-request counter: GitHub numbers both from one sequence. */
  nextNumber: number;
  nextCommentId: number;
  /** Bumped on any mutation: the REST and git caches compare against it. */
  version: number;
  /** Bumped when objects or refs change: the fetch pack cache compares against it. */
  gitGeneration: number;
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export class StoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** The identity a commit the forge itself writes carries. */
function forgeIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

/** Count the lines of a blob the way a diff does: a trailing newline ends the last line, it is not one. */
function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function splitLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

/** The longest-common-subsequence length of two line lists, with a cell cap for very large files. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  if (n * m > 1_000_000) return -1;
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m] as number;
}

export class Store {
  readonly clock: TrialClock;
  private readonly repos = new Map<string, RepoRecord>();
  private nextRepoId = 1;

  constructor(clock: TrialClock) {
    this.clock = clock;
  }

  // ------------------------------------------------------------------ repositories

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean } = {}): RepoRecord | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const now = this.clock.nextIso();
    const repo: RepoRecord = {
      id: this.nextRepoId,
      owner,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      version: 1,
      gitGeneration: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  /** A repository by its numeric database id, or undefined. Repositories are few; a scan is fine. */
  getRepoById(id: number): RepoRecord | undefined {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return undefined;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  reposOf(owner: string): RepoRecord[] {
    const out: RepoRecord[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  touch(repo: RepoRecord): void {
    repo.version += 1;
    repo.updatedAt = this.clock.nextIso();
  }

  // ------------------------------------------------------------------ objects and refs

  putObject(repo: RepoRecord, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.gitGeneration += 1;
    }
    return oid;
  }

  putObjects(repo: RepoRecord, objects: Iterable<GitObject>): void {
    for (const object of objects) this.putObject(repo, object.type, object.data);
  }

  getObject(repo: RepoRecord, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  objectLookup(repo: RepoRecord): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  getRef(repo: RepoRecord, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: RepoRecord, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.gitGeneration += 1;
    repo.version += 1;
  }

  deleteRef(repo: RepoRecord, ref: string): boolean {
    const had = repo.refs.delete(ref);
    if (had) {
      repo.gitGeneration += 1;
      repo.version += 1;
    }
    return had;
  }

  /** Branch names (no refs/heads/ prefix) with their tips, in ref order. */
  listBranches(repo: RepoRecord): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  resolveRef(repo: RepoRecord, ref: string): string | undefined {
    if (ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : undefined;
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return direct;
    const headed = repo.refs.get(`refs/heads/${ref}`);
    if (headed !== undefined) return headed;
    return repo.refs.get(`refs/tags/${ref}`);
  }

  // ------------------------------------------------------------------ labels, issues, pulls, comments

  createLabel(repo: RepoRecord, name: string, color?: string, description?: string): LabelRecord | null {
    if (repo.labels.has(name)) return null;
    const label: LabelRecord = { name, color: color ?? 'ededed', description: description ?? '' };
    repo.labels.set(name, label);
    this.touch(repo);
    return label;
  }

  createIssue(
    repo: RepoRecord,
    fields: { title: string; body?: string; labels?: readonly string[] },
  ): IssueRecord {
    const labels: string[] = [];
    for (const name of fields.labels ?? []) {
      if (!repo.labels.has(name)) throw new StoreError(422, `label ${JSON.stringify(name)} does not exist`);
      labels.push(name);
    }
    const now = this.clock.nextIso();
    const issue: IssueRecord = {
      number: repo.nextNumber,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      labels,
      author: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    this.touch(repo);
    return issue;
  }

  getIssue(repo: RepoRecord, number: number): IssueRecord | undefined {
    return repo.issues.get(number);
  }

  getPull(repo: RepoRecord, number: number): PullRecord | undefined {
    return repo.pulls.get(number);
  }

  /** The issue or pull request numbered `number`, whichever it is. */
  getSubject(repo: RepoRecord, number: number): IssueRecord | PullRecord | undefined {
    return repo.issues.get(number) ?? repo.pulls.get(number);
  }

  patchIssue(repo: RepoRecord, number: number, patch: { state?: IssueState; title?: string; body?: string }): IssueRecord | null {
    const issue = repo.issues.get(number);
    if (issue === undefined) return null;
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedAt = this.clock.nextIso();
    issue.version += 1;
    this.touch(repo);
    return issue;
  }

  patchPullState(repo: RepoRecord, number: number, state: IssueState): PullRecord | null {
    const pull = repo.pulls.get(number);
    if (pull === undefined) return null;
    if (pull.merged) return pull;
    pull.state = state;
    pull.updatedAt = this.clock.nextIso();
    pull.version += 1;
    this.touch(repo);
    return pull;
  }

  addComment(repo: RepoRecord, number: number, body: string): CommentRecord | null {
    if (this.getSubject(repo, number) === undefined) return null;
    const now = this.clock.nextIso();
    const comment: CommentRecord = {
      id: repo.nextCommentId,
      subjectNumber: number,
      body,
      author: VIEWER.login,
      createdAt: now,
      updatedAt: now,
    };
    repo.nextCommentId += 1;
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    const issue = repo.issues.get(number);
    if (issue !== undefined) issue.version += 1;
    const pull = repo.pulls.get(number);
    if (pull !== undefined) pull.version += 1;
    this.touch(repo);
    return comment;
  }

  listComments(repo: RepoRecord, number: number): CommentRecord[] {
    return repo.comments.get(number) ?? [];
  }

  listIssues(
    repo: RepoRecord,
    options: { state?: IssueState | 'all'; sort?: 'created' | 'updated'; direction?: 'asc' | 'desc' } = {},
  ): IssueRecord[] {
    const state = options.state ?? 'open';
    const direction = options.direction ?? 'desc';
    const out = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
    out.sort((a, b) => {
      const keyA = options.sort === 'updated' ? a.updatedAt : a.createdAt;
      const keyB = options.sort === 'updated' ? b.updatedAt : b.createdAt;
      if (keyA !== keyB) return direction === 'asc' ? (keyA < keyB ? -1 : 1) : (keyA > keyB ? -1 : 1);
      return direction === 'asc' ? a.number - b.number : b.number - a.number;
    });
    return out;
  }

  listPulls(repo: RepoRecord, options: { state?: IssueState | 'all' } = {}): PullRecord[] {
    const state = options.state ?? 'open';
    const out = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
    out.sort((a, b) => b.number - a.number);
    return out;
  }

  createPull(
    repo: RepoRecord,
    fields: { title: string; body?: string; head: string; base: string },
  ): PullRecord {
    const headSha = repo.refs.get(`refs/heads/${fields.head}`);
    if (headSha === undefined) throw new StoreError(422, `head branch ${JSON.stringify(fields.head)} does not exist`);
    if (repo.refs.get(`refs/heads/${fields.base}`) === undefined) {
      throw new StoreError(422, `base branch ${JSON.stringify(fields.base)} does not exist`);
    }
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === fields.head && pull.baseRef === fields.base) {
        throw new StoreError(422, `a pull request from ${fields.head} into ${fields.base} is already open`);
      }
    }
    const now = this.clock.nextIso();
    const pull: PullRecord = {
      number: repo.nextNumber,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      merged: false,
      headRef: fields.head,
      baseRef: fields.base,
      headSha,
      mergedAt: null,
      mergeCommitSha: null,
      author: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    this.touch(repo);
    return pull;
  }

  /** The live head tip of a pull request (the snapshot when the branch is gone). */
  pullHeadSha(repo: RepoRecord, pull: PullRecord): string {
    return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  }

  /** The live base tip of a pull request. */
  pullBaseSha(repo: RepoRecord, pull: PullRecord): string | undefined {
    return repo.refs.get(`refs/heads/${pull.baseRef}`);
  }

  // ------------------------------------------------------------------ diffs and merges

  /** The changed files between two trees: added, removed and modified, with line counts. */
  diffTrees(repo: RepoRecord, baseTreeOid: string, headTreeOid: string): FileChange[] {
    const lookup = this.objectLookup(repo);
    const baseFlat = flattenTree(lookup, baseTreeOid);
    const headFlat = flattenTree(lookup, headTreeOid);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const baseEntry = baseFlat.get(path);
      const headEntry = headFlat.get(path);
      if (baseEntry !== undefined && headEntry !== undefined && baseEntry.oid === headEntry.oid) continue;
      if (baseEntry === undefined && headEntry !== undefined) {
        const data = repo.objects.get(headEntry.oid)?.data ?? Buffer.alloc(0);
        const additions = countLines(data);
        changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (baseEntry !== undefined && headEntry === undefined) {
        const data = repo.objects.get(baseEntry.oid)?.data ?? Buffer.alloc(0);
        const deletions = countLines(data);
        changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (baseEntry !== undefined && headEntry !== undefined) {
        const oldData = repo.objects.get(baseEntry.oid)?.data ?? Buffer.alloc(0);
        const newData = repo.objects.get(headEntry.oid)?.data ?? Buffer.alloc(0);
        const oldLines = splitLines(oldData);
        const newLines = splitLines(newData);
        const common = lcsLength(oldLines, newLines);
        const additions = common < 0 ? newLines.length : newLines.length - common;
        const deletions = common < 0 ? oldLines.length : oldLines.length - common;
        changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return changes;
  }

  /** A pull request's files: the diff from its merge base to its head. */
  pullFiles(repo: RepoRecord, pull: PullRecord): FileChange[] {
    const lookup = this.objectLookup(repo);
    const headSha = this.pullHeadSha(repo, pull);
    const baseSha = this.pullBaseSha(repo, pull);
    if (baseSha === undefined) return [];
    const base = mergeBase(lookup, baseSha, headSha);
    const headTree = parseCommit(repo.objects.get(headSha)?.data ?? Buffer.alloc(0)).tree;
    if (base === null) {
      const emptyTree = this.putObject(repo, 'tree', Buffer.alloc(0));
      return this.diffTrees(repo, emptyTree, headTree);
    }
    const baseTree = parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    return this.diffTrees(repo, baseTree, headTree);
  }

  /**
   * The three-way merge of a pull request: base tip + head changes since the
   * merge base. Returns the merged tree, or null when the two sides conflict
   * (both changed the same path differently, or one deleted what the other
   * changed).
   */
  computeMergeTree(repo: RepoRecord, pull: PullRecord): string | null {
    const lookup = this.objectLookup(repo);
    const headSha = this.pullHeadSha(repo, pull);
    const baseSha = this.pullBaseSha(repo, pull);
    if (baseSha === undefined) return null;
    const base = mergeBase(lookup, baseSha, headSha);
    const baseTipTree = parseCommit(repo.objects.get(baseSha)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(repo.objects.get(headSha)?.data ?? Buffer.alloc(0)).tree;
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const baseFlat = baseTree === null ? new Map() : flattenTree(lookup, baseTree);
    const tipFlat = flattenTree(lookup, baseTipTree);
    const headFlat = flattenTree(lookup, headTree);
    const paths = new Set([...baseFlat.keys(), ...tipFlat.keys(), ...headFlat.keys()]);
    const changes = new Map<string, string | null>();
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid ?? null;
      const t = tipFlat.get(path)?.oid ?? null;
      const h = headFlat.get(path)?.oid ?? null;
      if (t === h) continue;
      if (b === t) {
        changes.set(path, h);
      } else if (b === h) {
        continue;
      } else {
        return null;
      }
    }
    return buildTreeFromChanges(lookup, (type, data) => this.putObject(repo, type, data), baseTipTree, changes);
  }

  mergeable(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' {
    if (pull.state !== 'open') return 'CONFLICTING';
    return this.computeMergeTree(repo, pull) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request: one commit on the base branch whose parent is
   * the base tip and whose tree is the three-way merge. The pull request
   * closes as merged. Throws StoreError 405 when it is already merged or
   * closed, or when the merge conflicts.
   */
  mergePull(repo: RepoRecord, pull: PullRecord): { sha: string } {
    if (pull.merged || pull.state !== 'open') {
      throw new StoreError(405, 'the pull request is already merged or closed');
    }
    const baseSha = this.pullBaseSha(repo, pull);
    if (baseSha === undefined) throw new StoreError(405, 'the base branch does not exist');
    const mergedTree = this.computeMergeTree(repo, pull);
    if (mergedTree === null) throw new StoreError(405, 'the pull request has conflicts that must be resolved');
    const identity = forgeIdentity();
    const commit = buildCommit({
      tree: mergedTree,
      parents: [baseSha],
      message: pull.title,
      author: identity,
      committer: identity,
      timestamp: this.clock.nextSec(),
    });
    const sha = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    repo.gitGeneration += 1;
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = this.clock.nextIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    pull.version += 1;
    this.touch(repo);
    return { sha };
  }

  // ------------------------------------------------------------------ commit walks and contents

  /** The commits reachable from `tip`, newest first (committer time, then walk order). */
  walkCommits(repo: RepoRecord, tip: string, limit = 100): Array<{ sha: string; message: string; tree: string; parents: string[] }> {
    const lookup = this.objectLookup(repo);
    const seen = new Set<string>();
    const queue: string[] = [tip];
    const found: Array<{ sha: string; time: number; order: number; message: string; tree: string; parents: string[] }> = [];
    let order = 0;
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = lookup(sha);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const committer = commit.committer.trim().split(' ');
      const time = Number.parseInt(committer[committer.length - 2] ?? '0', 10) || 0;
      found.push({ sha, time, order: order, message: commit.message, tree: commit.tree, parents: commit.parents });
      order += 1;
      for (const parent of commit.parents) queue.push(parent);
    }
    found.sort((a, b) => (b.time - a.time) || (a.order - b.order));
    return found.slice(0, limit).map(({ sha, message, tree, parents }) => ({ sha, message, tree, parents }));
  }

  /** Read a path at a ref: a file, a directory listing, or null when missing. */
  readPath(
    repo: RepoRecord,
    ref: string,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer; size: number } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return null;
    const tipObject = repo.objects.get(tip);
    if (tipObject === undefined || tipObject.type !== 'commit') return null;
    const rootTree = parseCommit(tipObject.data).tree;
    const lookup = this.objectLookup(repo);
    if (path === '') {
      return { kind: 'dir', entries: this.listTree(repo, rootTree, '') };
    }
    const flat = flattenTree(lookup, rootTree);
    const file = flat.get(path);
    if (file !== undefined) {
      const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
      return { kind: 'file', oid: file.oid, data, size: data.length };
    }
    const treeOid = this.treeAtPath(repo, rootTree, path);
    if (treeOid === null) return null;
    return { kind: 'dir', entries: this.listTree(repo, treeOid, path) };
  }

  /** The tree object id at a directory path, walking the tree hierarchy; null when it is not a directory. */
  private treeAtPath(repo: RepoRecord, rootTree: string, path: string): string | null {
    let current = rootTree;
    for (const segment of path.split('/')) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return null;
      current = entry.oid;
    }
    return current;
  }

  private listTree(repo: RepoRecord, treeOid: string, prefix: string): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      oid: entry.oid,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  /**
   * Write a file through the contents API: a new commit on `branch` carrying
   * the change. On an unborn repository the first commit creates the branch.
   * `sha`, when given, must be the blob the path currently holds (else 409).
   */
  commitFile(
    repo: RepoRecord,
    fields: { branch: string; path: string; content: Buffer; message: string; sha?: string },
  ): { commitSha: string; blobSha: string; created: boolean } {
    const ref = `refs/heads/${fields.branch}`;
    const tip = repo.refs.get(ref);
    const lookup = this.objectLookup(repo);
    const blobSha = this.putObject(repo, 'blob', fields.content);
    let baseTree: string | null = null;
    let parents: string[] = [];
    let created = false;
    if (tip === undefined) {
      if (repo.refs.size > 0) throw new StoreError(404, `branch ${JSON.stringify(fields.branch)} does not exist`);
      created = true;
    } else {
      const tipObject = repo.objects.get(tip);
      if (tipObject === undefined || tipObject.type !== 'commit') throw new StoreError(404, 'the branch tip is not a commit');
      const commit = parseCommit(tipObject.data);
      baseTree = commit.tree;
      parents = [tip];
      const flat = flattenTree(lookup, baseTree);
      const current = flat.get(fields.path);
      if (fields.sha !== undefined) {
        if (current === undefined || current.oid !== fields.sha) {
          throw new StoreError(409, 'the sha does not match the file the path currently holds');
        }
      }
      if (current === undefined) created = true;
    }
    if (fields.sha !== undefined && tip === undefined) {
      throw new StoreError(409, 'the sha does not match the file the path currently holds');
    }
    const changes = new Map<string, string | null>([[fields.path, blobSha]]);
    const tree = buildTreeFromChanges(lookup, (type, data) => this.putObject(repo, type, data), baseTree, changes);
    const identity = forgeIdentity();
    const commit = buildCommit({
      tree,
      parents,
      message: fields.message,
      author: identity,
      committer: identity,
      timestamp: this.clock.nextSec(),
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    repo.gitGeneration += 1;
    this.touch(repo);
    return { commitSha, blobSha, created };
  }

  /**
   * Delete a file through the contents API. `sha` must be the blob the path
   * currently holds (else 409); a missing path is 404.
   */
  deleteFile(
    repo: RepoRecord,
    fields: { branch: string; path: string; message: string; sha: string },
  ): { commitSha: string } {
    const ref = `refs/heads/${fields.branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) throw new StoreError(404, `branch ${JSON.stringify(fields.branch)} does not exist`);
    const tipObject = repo.objects.get(tip);
    if (tipObject === undefined || tipObject.type !== 'commit') throw new StoreError(404, 'the branch tip is not a commit');
    const commit = parseCommit(tipObject.data);
    const lookup = this.objectLookup(repo);
    const flat = flattenTree(lookup, commit.tree);
    const current = flat.get(fields.path);
    if (current === undefined) throw new StoreError(404, `path ${JSON.stringify(fields.path)} does not exist`);
    if (current.oid !== fields.sha) throw new StoreError(409, 'the sha does not match the file the path currently holds');
    const changes = new Map<string, string | null>([[fields.path, null]]);
    const tree = buildTreeFromChanges(lookup, (type, data) => this.putObject(repo, type, data), commit.tree, changes);
    const identity = forgeIdentity();
    const next = buildCommit({
      tree,
      parents: [tip],
      message: fields.message,
      author: identity,
      committer: identity,
      timestamp: this.clock.nextSec(),
    });
    const commitSha = this.putObject(repo, 'commit', next);
    repo.refs.set(ref, commitSha);
    repo.gitGeneration += 1;
    this.touch(repo);
    return { commitSha };
  }

  /** True when `newOid` descends from `oldOid` (the fast-forward rule for pushes). */
  isFastForward(repo: RepoRecord, oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_OID) return true;
    if (oldOid === newOid) return true;
    return isAncestor(this.objectLookup(repo), oldOid, newOid);
  }

  /** Every object id reachable from the given roots (the fetch object selection's input). */
  reachable(repo: RepoRecord, roots: Iterable<string>, barrier?: ReadonlySet<string>): Set<string> {
    return collectReachable(roots, this.objectLookup(repo), { barrier });
  }
}
