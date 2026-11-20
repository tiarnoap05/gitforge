// The GraphQL surface: a small executor for exactly the document subset the
// suite sends — one operation per body (or a JSON-array batch), queries and
// mutations, $variables, inline enum lists and input objects, aliases, and
// inline fragments. The suite's documents are fixed strings; nothing builds
// GraphQL text at run time.
//
// Global ids are opaque and stable: base64("<Kind>:<databaseId>[:<number>]").
// They decode back to the same store records the mutations and node(id:)
// need, and they never equal the plain numeric id. An unknown field is a
// GraphQL error (HTTP 200, errors array naming the field, data null), never
// an HTTP 400; an unknown repository is data.repository = null with no
// errors at all.

import { VIEWER } from './identity.ts';
import { headerValue, isRecord, jsonError, jsonResponse } from './http.ts';
import type { ForgeRequest, ForgeResponse } from './http.ts';
import { Store, StoreError } from './store.ts';
import type { IssueRecord, PullRecord, RepoRecord } from './store.ts';

// ------------------------------------------------------------- global ids

type GlobalIdKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User';

export function encodeGlobalId(kind: GlobalIdKind, databaseId: number, number?: number): string {
  const plain = number === undefined ? `${kind}:${databaseId}` : `${kind}:${databaseId}:${number}`;
  return Buffer.from(plain, 'utf8').toString('base64');
}

interface DecodedGlobalId {
  readonly kind: GlobalIdKind;
  readonly databaseId: number;
  readonly number: number | undefined;
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  let plain: string;
  try {
    plain = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = plain.split(':');
  const kind = parts[0] as GlobalIdKind | undefined;
  if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment' && kind !== 'User') return null;
  const databaseId = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(databaseId) || databaseId <= 0) return null;
  let number: number | undefined;
  if (parts.length > 2) {
    number = Number.parseInt(parts[2] as string, 10);
    if (!Number.isInteger(number) || number <= 0) return null;
  }
  // The encoding must round-trip exactly, so a lookalike string never decodes.
  if (encodeGlobalId(kind, databaseId, number) !== id) return null;
  return { kind, databaseId, number };
}

function encodeCursor(number: number): string {
  return Buffer.from(String(number), 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  let plain: string;
  try {
    plain = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!/^\d+$/.test(plain)) return null;
  return Number.parseInt(plain, 10);
}

// ------------------------------------------------------------- the tokenizer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const PUNCTUATION = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '$', '=', '@', '|', '&']);

class GraphQLSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLSyntaxError';
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if (PUNCTUATION.has(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < source.length) {
        const current = source[index] as string;
        if (current === '"') {
          index += 1;
          break;
        }
        if (current === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u' && index + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
            index += 6;
          } else {
            value += map[escaped] ?? escaped;
            index += 2;
          }
          continue;
        }
        value += current;
        index += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index));
      if (match === null) throw new GraphQLSyntaxError(`bad number at offset ${index}`);
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      index += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index)) as RegExpExecArray;
      tokens.push({ kind: 'name', value: match[0] });
      index += match[0].length;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(char)} at offset ${index}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------- the parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | undefined;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selectionSet: SelectionNode[] | undefined;
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string | undefined;
  readonly selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  readonly operation: 'query' | 'mutation';
  readonly name: string | undefined;
  readonly variableNames: string[];
  readonly selectionSet: SelectionNode[];
}

interface FragmentDefinition {
  readonly name: string;
  readonly typeCondition: string;
  readonly selectionSet: SelectionNode[];
}

class Parser {
  private position = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.position] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.position] as Token;
    this.position += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLSyntaxError(`expected ${what}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentDefinition> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: undefined, variableNames: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableNames = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation, name, variableNames, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        const on = this.expectName('the keyword on');
        if (on !== 'on') throw new GraphQLSyntaxError('expected the keyword on in a fragment definition');
        const typeCondition = this.expectName('a type condition');
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new GraphQLSyntaxError(`unexpected token ${JSON.stringify(token.value)} at the document top level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): string[] {
    const names: string[] = [];
    if (this.peek().kind !== 'punct' || this.peek().value !== '(') return names;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      names.push(this.expectName('a variable name'));
      this.expectPunct(':');
      this.parseType();
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
    return names;
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type condition');
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        if (this.peek().kind === 'punct' && this.peek().value === '{') {
          // A spread with an inline set is not valid GraphQL, but treat it as
          // a fragment on the named type rather than failing the document.
          return { kind: 'fragment', typeCondition: name, selectionSet: this.parseSelectionSet() };
        }
        return { kind: 'fragment', typeCondition: undefined, selectionSet: [] };
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition: undefined, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind !== 'punct' || this.peek().value !== '(') return args;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName('a variable name') };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
            const name = this.expectName('an object field name');
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        break;
      default:
        break;
    }
    throw new GraphQLSyntaxError(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ------------------------------------------------------------- the schema

/** The fields each object type carries, and the type each field resolves to.
 *  A trailing "!" is only documentation here; nullability is handled by the
 *  resolvers (a null parent short-circuits its whole selection). */
const SCHEMA: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'Viewer', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Viewer: { login: 'String', id: 'ID', name: 'String', email: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    description: 'String',
    owner: 'RepositoryOwner',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    isPrivate: 'Boolean',
    url: 'String',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  RepositoryOwner: { login: 'String', id: 'ID' },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'String', url: 'String', createdAt: 'String', updatedAt: 'String' },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', endCursor: 'String', startCursor: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    merged: 'Boolean',
    mergeable: 'String',
    headRefName: 'String',
    baseRefName: 'String',
    mergedAt: 'String',
    createdAt: 'String',
    updatedAt: 'String',
    url: 'String',
    files: 'PullRequestFileConnection',
  },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestFileConnection: { nodes: '[PullRequestFile]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID', body: 'String', createdAt: 'String', updatedAt: 'String' },
  Node: { id: 'ID' },
};

/** The field names __type().fields reports, per type. */
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'assignees'],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files',
    'title', 'body', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'additions', 'deletions', 'changedFiles', 'commits', 'author',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'fork',
  ],
  Viewer: ['login', 'id', 'name', 'email'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

/** Validate every field in the document against the schema before executing
 *  anything, so one unknown field fails the whole operation the way GitHub
 *  does. Inline fragments narrow the type; a fragment on an unknown type
 *  never matches and its fields are skipped. */
function validateSelections(
  selections: readonly SelectionNode[],
  typeName: string,
  fragments: ReadonlyMap<string, FragmentDefinition>,
): void {
  const fields = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === undefined) {
        validateSelections(selection.selectionSet, typeName, fragments);
      } else if (SCHEMA[selection.typeCondition] !== undefined) {
        validateSelections(selection.selectionSet, selection.typeCondition, fragments);
      }
      continue;
    }
    if (fields === undefined || fields[selection.name] === undefined) {
      throw new GraphQLError(`Cannot query field "${selection.name}" on type "${typeName}".`);
    }
    if (selection.selectionSet !== undefined) {
      const fieldType = fields[selection.name] as string;
      const inner = fieldType.replace(/^\[/, '').replace(/\]$/, '');
      if (SCHEMA[inner] !== undefined) validateSelections(selection.selectionSet, inner, fragments);
    }
  }
}

// ------------------------------------------------------------- values

type Variables = Readonly<Record<string, unknown>>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Variables): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
  return args;
}

// ------------------------------------------------------------- source objects

interface SourceObject {
  readonly __typename: string;
  readonly [key: string]: unknown;
}

function repoSource(repo: RepoRecord): SourceObject {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: RepoRecord, issue: IssueRecord): SourceObject {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: RepoRecord, pull: PullRecord): SourceObject {
  return { __typename: 'PullRequest', repo, pull };
}

function issueState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ------------------------------------------------------------- the executor

export interface GraphQLContext {
  readonly store: Store;
  readonly token: string;
}

interface ExecutionState {
  readonly store: Store;
  readonly variables: Variables;
}

function connectionPage<T extends { number: number }>(
  items: readonly T[],
  args: Record<string, unknown>,
): { page: T[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null } {
  const afterRaw = args.after;
  let startIndex = 0;
  if (typeof afterRaw === 'string' && afterRaw !== '') {
    const decoded = decodeCursor(afterRaw);
    if (decoded !== null) {
      const found = items.findIndex((item) => item.number === decoded);
      if (found >= 0) startIndex = found + 1;
    }
  }
  const firstRaw = args.first;
  const first = typeof firstRaw === 'number' && Number.isFinite(firstRaw) && firstRaw >= 0 ? Math.floor(firstRaw) : items.length;
  const page = items.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < items.length;
  const last = page[page.length - 1];
  const firstItem = page[0];
  return {
    page,
    hasNextPage,
    endCursor: last === undefined ? null : encodeCursor(last.number),
    startCursor: firstItem === undefined ? null : encodeCursor(firstItem.number),
  };
}

function resolveField(source: SourceObject, field: FieldNode, args: Record<string, unknown>, state: ExecutionState): unknown {
  const { store } = state;
  const typeName = source.__typename;

  if (typeName === 'Query') {
    if (field.name === 'viewer') return { __typename: 'Viewer' };
    if (field.name === 'repository') {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : repoSource(repo);
    }
    if (field.name === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      const repo = store.getRepoById(decoded.databaseId);
      if (repo === undefined) return null;
      if (decoded.kind === 'Repository') return repoSource(repo);
      if (decoded.kind === 'Issue' && decoded.number !== undefined) {
        const issue = store.getIssue(repo, decoded.number);
        return issue === undefined ? null : issueSource(repo, issue);
      }
      if (decoded.kind === 'PullRequest' && decoded.number !== undefined) {
        const pull = store.getPull(repo, decoded.number);
        return pull === undefined ? null : pullSource(repo, pull);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return null;
      if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return { __typename: '__Type', typeName: name };
    }
  }

  if (typeName === 'Mutation') {
    return resolveMutation(source, field, args, state);
  }

  if (typeName === 'Viewer') {
    if (field.name === 'login') return VIEWER.login;
    if (field.name === 'id') return encodeGlobalId('User', VIEWER.id);
    if (field.name === 'name') return VIEWER.name;
    if (field.name === 'email') return VIEWER.email;
  }

  if (typeName === 'Repository') {
    const repo = source.repo as RepoRecord;
    switch (field.name) {
      case 'id':
        return encodeGlobalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'description':
        return repo.description;
      case 'owner':
        return { __typename: 'RepositoryOwner' };
      case 'defaultBranchRef': {
        const tip = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'isPrivate':
        return repo.isPrivate;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}`;
      case 'issue': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = store.getIssue(repo, number);
        return issue === undefined ? null : issueSource(repo, issue);
      }
      case 'issues': {
        const statesRaw = args.states;
        const states = Array.isArray(statesRaw) ? statesRaw.filter((entry): entry is string => typeof entry === 'string') : [];
        const state = states.length === 0 ? 'open' : states.includes('OPEN') && states.includes('CLOSED') ? 'all' : states.includes('CLOSED') ? 'closed' : 'open';
        const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
        const direction = orderBy.direction === 'ASC' ? 'asc' : orderBy.direction === 'DESC' ? 'desc' : 'asc';
        const sort = orderBy.field === 'UPDATED_AT' ? 'updated' : 'created';
        const ordered = store.listIssues(repo, { state, sort, direction });
        const paged = connectionPage(ordered, args);
        return {
          __typename: 'IssueConnection',
          nodes: paged.page.map((issue) => issueSource(repo, issue)),
          pageInfo: { __typename: 'PageInfo', hasNextPage: paged.hasNextPage, hasPreviousPage: false, endCursor: paged.endCursor, startCursor: paged.startCursor },
          totalCount: ordered.length,
        };
      }
      case 'pullRequests': {
        const statesRaw = args.states;
        const states = Array.isArray(statesRaw) ? statesRaw.filter((entry): entry is string => typeof entry === 'string') : [];
        const state = states.length === 0 ? 'open' : states.includes('OPEN') && (states.includes('CLOSED') || states.includes('MERGED')) ? 'all' : 'closed';
        const ordered = store.listPulls(repo, { state });
        const paged = connectionPage(ordered, args);
        return {
          __typename: 'PullRequestConnection',
          nodes: paged.page.map((pull) => pullSource(repo, pull)),
          pageInfo: { __typename: 'PageInfo', hasNextPage: paged.hasNextPage, hasPreviousPage: false, endCursor: paged.endCursor, startCursor: paged.startCursor },
          totalCount: ordered.length,
        };
      }
      case 'pullRequest': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pull = store.getPull(repo, number);
        return pull === undefined ? null : pullSource(repo, pull);
      }
      default:
        break;
    }
  }

  if (typeName === 'RepositoryOwner') {
    if (field.name === 'login') return VIEWER.login;
    if (field.name === 'id') return encodeGlobalId('User', VIEWER.id);
  }

  if (typeName === 'Ref') {
    if (field.name === 'name') return source.name;
  }

  if (typeName === 'Issue') {
    const repo = source.repo as RepoRecord;
    const issue = source.issue as IssueRecord;
    switch (field.name) {
      case 'id':
        return encodeGlobalId('Issue', repo.id, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issueState(issue.state);
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      default:
        break;
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
    if (field.name === 'nodes') return source.nodes;
    if (field.name === 'pageInfo') return source.pageInfo;
    if (field.name === 'totalCount') return source.totalCount;
  }

  if (typeName === 'PageInfo') {
    if (field.name === 'hasNextPage') return source.hasNextPage;
    if (field.name === 'hasPreviousPage') return source.hasPreviousPage;
    if (field.name === 'endCursor') return source.endCursor;
    if (field.name === 'startCursor') return source.startCursor;
  }

  if (typeName === 'PullRequest') {
    const repo = source.repo as RepoRecord;
    const pull = source.pull as PullRecord;
    switch (field.name) {
      case 'id':
        return encodeGlobalId('PullRequest', repo.id, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return pull.state === 'open' ? store.mergeable(repo, pull) : pull.merged ? 'MERGEABLE' : 'CONFLICTING';
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergedAt':
        return pull.mergedAt;
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const files = store.pullFiles(repo, pull);
        const firstRaw = args.first;
        const first = typeof firstRaw === 'number' && Number.isFinite(firstRaw) && firstRaw >= 0 ? Math.floor(firstRaw) : files.length;
        const page = files.slice(0, first);
        return {
          __typename: 'PullRequestFileConnection',
          nodes: page.map((file) => ({
            __typename: 'PullRequestFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: page.length < files.length, hasPreviousPage: false, endCursor: null, startCursor: null },
          totalCount: files.length,
        };
      }
      default:
        break;
    }
  }

  if (typeName === 'PullRequestFile') {
    if (field.name === 'path') return source.path;
    if (field.name === 'additions') return source.additions;
    if (field.name === 'deletions') return source.deletions;
    if (field.name === 'changeType') return source.changeType;
  }

  if (typeName === '__Type') {
    const typeNameValue = source.typeName as string;
    if (field.name === 'name') return typeNameValue;
    if (field.name === 'kind') return TYPE_FIELDS[typeNameValue] !== undefined ? 'OBJECT' : 'ENUM';
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[typeNameValue] ?? [];
      return names.map((name) => ({ __typename: '__Field', name }));
    }
    if (field.name === 'enumValues') {
      const names = ENUM_VALUES[typeNameValue] ?? [];
      return names.map((name) => ({ __typename: '__EnumValue', name }));
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return source.name;
    if (field.name === 'description') return '';
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field.name === 'issue') return source.issue;
  }

  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return source.pullRequest;
  }

  if (typeName === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return source.commentEdge;
  }

  if (typeName === 'CommentEdge') {
    if (field.name === 'node') return source.node;
  }

  if (typeName === 'IssueComment') {
    if (field.name === 'id') return source.id;
    if (field.name === 'body') return source.body;
    if (field.name === 'createdAt') return source.createdAt;
    if (field.name === 'updatedAt') return source.updatedAt;
  }

  if (typeName === 'Node') {
    if (field.name === 'id') return source.id;
  }

  throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
}

function resolveMutation(_source: SourceObject, field: FieldNode, args: Record<string, unknown>, state: ExecutionState): unknown {
  const { store } = state;
  const input = isRecord(args.input) ? args.input : {};
  const decodeRepo = (id: unknown): RepoRecord => {
    if (typeof id !== 'string') throw new GraphQLError('a global id is required');
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Repository') throw new GraphQLError('the repository id is not valid');
    const repo = store.getRepoById(decoded.databaseId);
    if (repo === undefined) throw new GraphQLError('the repository does not exist');
    return repo;
  };

  if (field.name === 'createIssue') {
    const repo = decodeRepo(input.repositoryId);
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw new GraphQLError('a title is required');
    const issue = store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
    return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue) };
  }
  if (field.name === 'closeIssue') {
    const id = input.issueId;
    if (typeof id !== 'string') throw new GraphQLError('an issue id is required');
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue' || decoded.number === undefined) throw new GraphQLError('the issue id is not valid');
    const repo = store.getRepoById(decoded.databaseId);
    if (repo === undefined) throw new GraphQLError('the repository does not exist');
    const issue = store.patchIssue(repo, decoded.number, { state: 'closed' });
    if (issue === null) throw new GraphQLError('the issue does not exist');
    return { __typename: 'CloseIssuePayload', issue: issueSource(repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const repo = decodeRepo(input.repositoryId);
    const title = input.title;
    const head = input.headRefName;
    const base = input.baseRefName;
    if (typeof title !== 'string' || title === '') throw new GraphQLError('a title is required');
    if (typeof head !== 'string' || typeof base !== 'string') throw new GraphQLError('a head and base ref are required');
    const pull = store.createPull(repo, { title, body: typeof input.body === 'string' ? input.body : '', head, base });
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull) };
  }
  if (field.name === 'mergePullRequest') {
    const id = input.pullRequestId;
    if (typeof id !== 'string') throw new GraphQLError('a pull request id is required');
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest' || decoded.number === undefined) {
      throw new GraphQLError('the pull request id is not valid');
    }
    const repo = store.getRepoById(decoded.databaseId);
    if (repo === undefined) throw new GraphQLError('the repository does not exist');
    const pull = store.getPull(repo, decoded.number);
    if (pull === undefined) throw new GraphQLError('the pull request does not exist');
    store.mergePull(repo, pull);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(repo, pull) };
  }
  if (field.name === 'addComment') {
    const id = input.subjectId;
    if (typeof id !== 'string') throw new GraphQLError('a subject id is required');
    const decoded = decodeGlobalId(id);
    if (decoded === null || (decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest') || decoded.number === undefined) {
      throw new GraphQLError('the subject id is not valid');
    }
    const repo = store.getRepoById(decoded.databaseId);
    if (repo === undefined) throw new GraphQLError('the repository does not exist');
    const body = input.body;
    if (typeof body !== 'string' || body === '') throw new GraphQLError('a comment body is required');
    const comment = store.addComment(repo, decoded.number, body);
    if (comment === null) throw new GraphQLError('the subject does not exist');
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'CommentEdge',
        node: {
          __typename: 'IssueComment',
          id: encodeGlobalId('IssueComment', repo.id, comment.id),
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        },
      },
    };
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
}

function executeSelections(
  selections: readonly SelectionNode[],
  source: SourceObject,
  state: ExecutionState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== source.__typename) continue;
      // A node(id:) result carries its concrete type; a fragment on Node
      // itself always applies, and __typename stays the concrete one.
      Object.assign(out, executeSelections(selection.selectionSet, source, state));
      continue;
    }
    const args = resolveArgs(selection, state.variables);
    const value = resolveField(source, selection, args, state);
    const key = selection.alias ?? selection.name;
    if (selection.selectionSet === undefined) {
      out[key] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in item
          ? executeSelections(selection.selectionSet as SelectionNode[], item as SourceObject, state)
          : item,
      );
      continue;
    }
    if (typeof value === 'object' && '__typename' in value) {
      out[key] = executeSelections(selection.selectionSet, value as SourceObject, state);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(
  operation: OperationNode,
  fragments: ReadonlyMap<string, FragmentDefinition>,
  variables: Variables,
  store: Store,
): Record<string, unknown> {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(operation.selectionSet, rootType, fragments);
  const state: ExecutionState = { store, variables };
  const root: SourceObject = { __typename: rootType };
  return executeSelections(operation.selectionSet, root, state);
}

// ------------------------------------------------------------- the handler

export interface GraphQLOperationInput {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
}

function runOne(input: GraphQLOperationInput, store: Store): Record<string, unknown> {
  try {
    if (typeof input.query !== 'string' || input.query.trim() === '') {
      return { data: null, errors: [{ message: 'a query document is required' }] };
    }
    const variables = isRecord(input.variables) ? input.variables : {};
    const { operations, fragments } = new Parser(tokenize(input.query)).parseDocument();
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'the document holds no operation' }] };
    }
    let operation = operations[0] as OperationNode;
    if (typeof input.operationName === 'string') {
      const named = operations.find((candidate) => candidate.name === input.operationName);
      if (named !== undefined) operation = named;
    }
    const data = executeOperation(operation, fragments, variables, store);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError || err instanceof GraphQLSyntaxError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    if (err instanceof StoreError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    console.error('graphql handler error:', err);
    return { data: null, errors: [{ message: 'Internal server error' }] };
  }
}

export function handleGraphQL(request: ForgeRequest, ctx: GraphQLContext): ForgeResponse | null {
  if (request.pathname !== '/api/graphql') return null;
  if (request.method !== 'POST') return jsonError(404, 'Not Found');
  if (ctx.token !== '') {
    const auth = headerValue(request.headers, 'authorization');
    if (auth !== `Bearer ${ctx.token}`) return jsonError(401, 'Bad credentials');
  }
  let parsed: unknown;
  try {
    parsed = request.body.length === 0 ? null : (JSON.parse(request.body.toString('utf8')) as unknown);
  } catch {
    return jsonError(400, 'Problems parsing JSON');
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runOne(isRecord(entry) ? entry : {}, ctx.store));
    return jsonResponse(200, results);
  }
  if (isRecord(parsed)) {
    return jsonResponse(200, runOne(parsed, ctx.store));
  }
  return jsonError(400, 'Problems parsing JSON');
}
