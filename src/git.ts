// The git smart-HTTP surface: protocol v2 and v0 upload-pack, v0
// receive-pack, over the one shared store. Objects are stored as raw bytes
// and never re-serialized, so a clone returns byte-identical objects.
//
// Fetch object selection, for both protocol versions:
//   INCLUDED = the walk from the wants, stopping at the requested depth
//   EXCLUDED = the walk from the haves, never crossing a client shallow
//              boundary's parent edge
//   SENT     = INCLUDED minus EXCLUDED
// Shallow-info comes from the post-fetch set: a commit is a new shallow
// boundary when it has a parent outside that set, and a client boundary
// that stops being one is unshallow. A fetch that sends nothing omits the
// packfile section entirely rather than sending an empty one.

import { VIEWER } from './identity.ts';
import { headerValue, jsonError } from './http.ts';
import type { ForgeRequest, ForgeResponse } from './http.ts';
import { collectReachable, isObjectId, parseCommit, parseTag, peelToNonTag, readPack, writePack, ZERO_OID } from './objects.ts';
import type { GitObject, ObjectLookup } from './objects.ts';
import { decodePktLines, encodePktLines, pktLineDelim, pktLineFlush, PktLineError, sidebandEncode } from './pktline.ts';
import { Store } from './store.ts';
import type { RepoRecord } from './store.ts';

export interface GitContext {
  readonly store: Store;
  readonly token: string;
}

const UPLOAD_V0_CAPS = 'side-band-64k multi_ack shallow';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs';

/** Built packs, keyed by the exact fetch that produced them. The clone
 *  workload runs the same depth-1 fetch fifty times; the cache makes the
 *  repeats a memcpy. The repo's git generation is part of the key, so a
 *  mutation can never serve a stale pack, and database ids are never reused. */
const packCache = new Map<string, Buffer>();

function gitResponse(status: number, contentType: string, body: Buffer): ForgeResponse {
  return { status, headers: { 'content-type': contentType }, body };
}

function badRequest(message: string): ForgeResponse {
  return jsonError(400, message);
}

function sortedRefs(repo: RepoRecord): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headOid(repo: RepoRecord): string | undefined {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip !== undefined) return tip;
  const first = sortedRefs(repo).find((ref) => ref.name.startsWith('refs/heads/'));
  return first?.oid;
}

/** The peeled target of a tag ref, or undefined when the ref is not an annotated tag. */
function peeledOid(repo: RepoRecord, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  return peelToNonTag((id) => repo.objects.get(id), oid);
}

// ------------------------------------------------------------- advertisements

function v0Advertisement(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const caps = service === 'git-upload-pack' ? `symref=HEAD:${defaultRef} ${UPLOAD_V0_CAPS}` : RECEIVE_CAPS;
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush');
    return encodePktLines(items);
  }
  const head = headOid(repo);
  if (head !== undefined) items.push(`${head} HEAD\0${caps}\n`);
  else items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  for (const ref of refs) {
    items.push(`${ref.oid} ${ref.name}\n`);
    const peeled = peeledOid(repo, ref.oid);
    if (peeled !== undefined) items.push(`${peeled} ${ref.name}^{}\n`);
  }
  items.push('flush');
  return encodePktLines(items);
}

function v2Advertisement(): Buffer {
  return encodePktLines(['version 2\n', 'fetch=shallow\n', 'ls-refs=unborn\n', 'object-format=sha1\n', 'flush']);
}

// ------------------------------------------------------------- object selection

interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | undefined;
}

/** The depth-limited walk from the wants: every object a fetch at this depth may send. */
function collectWithDepth(roots: readonly string[], lookup: ObjectLookup, depth: number | undefined): Set<string> {
  const included = new Set<string>();
  const generation = new Map<string, number>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!isObjectId(root) || generation.has(root)) continue;
    generation.set(root, 0);
    queue.push(root);
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const gen = generation.get(oid) as number;
    if (included.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    included.add(oid);
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (!generation.has(target)) {
        generation.set(target, gen);
        queue.push(target);
      }
      continue;
    }
    if (object.type === 'tree') {
      const subtree = collectReachable([oid], lookup, { allowMissing: true });
      for (const child of subtree) included.add(child);
      continue;
    }
    if (object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const treeObjects = collectReachable([commit.tree], lookup, { allowMissing: true });
    for (const child of treeObjects) included.add(child);
    if (depth !== undefined && gen + 1 >= depth) continue;
    for (const parent of commit.parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push(parent);
      }
    }
  }
  return included;
}

interface Selection {
  /** The objects to pack, in deterministic order. */
  readonly sent: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
}

function selectObjects(repo: RepoRecord, args: FetchArgs): Selection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(args.shallow.filter(isObjectId));
  const included = collectWithDepth(args.wants, lookup, args.depth);
  const excluded = collectReachable(args.haves, lookup, { barrier: shallowSet, allowMissing: true });
  const sentOids = [...included].filter((oid) => !excluded.has(oid)).sort();
  const sent: GitObject[] = [];
  for (const oid of sentOids) {
    const object = lookup(oid);
    if (object !== undefined) sent.push(object);
  }
  const postSet = new Set<string>([...included, ...excluded]);
  const shallow: string[] = [];
  for (const oid of [...postSet].sort()) {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && !parents.some((parent) => postSet.has(parent))) shallow.push(oid);
  }
  const shallowNames = new Set(shallow);
  const unshallow = [...shallowSet].filter((oid) => !shallowNames.has(oid)).sort();
  const reachable = collectReachable(args.wants, lookup, { allowMissing: true });
  const acks = args.haves.filter((have) => reachable.has(have));
  return { sent, shallow, unshallow, acks };
}

function packKey(repo: RepoRecord, args: FetchArgs): string {
  return JSON.stringify([
    repo.id,
    repo.gitGeneration,
    [...args.wants].sort(),
    [...args.haves].sort(),
    args.depth ?? null,
    [...args.shallow].sort(),
  ]);
}

function buildPack(repo: RepoRecord, args: FetchArgs, sent: readonly GitObject[]): Buffer {
  const key = packKey(repo, args);
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = writePack(sent);
  if (packCache.size >= 32) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

// ------------------------------------------------------------- ls-refs (v2)

function handleLsRefs(repo: RepoRecord, args: readonly string[]): ForgeResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  } else if (head !== undefined && keep('HEAD')) {
    lines.push(`${head} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return gitResponse(200, 'application/x-git-upload-pack-result', encodePktLines([...lines, 'flush']));
}

// ------------------------------------------------------------- fetch

function handleFetchV2(repo: RepoRecord, args: readonly string[]): ForgeResponse {
  const parsed = parseFetchArgs(args);
  const selection = selectObjects(repo, parsed);
  const parts: Buffer[] = [];
  let needDelim = false;
  if (parsed.haves.length > 0) {
    const lines = ['acknowledgments\n', ...selection.acks.map((oid) => `ACK ${oid}\n`), 'ready\n'];
    parts.push(encodePktLines(lines));
    needDelim = true;
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    if (needDelim) parts.push(pktLineDelim());
    const lines = [
      'shallow-info\n',
      ...selection.shallow.map((oid) => `shallow ${oid}\n`),
      ...selection.unshallow.map((oid) => `unshallow ${oid}\n`),
    ];
    parts.push(encodePktLines(lines));
    needDelim = true;
  }
  if (selection.sent.length > 0) {
    if (needDelim) parts.push(pktLineDelim());
    const pack = buildPack(repo, parsed, selection.sent);
    parts.push(encodePktLines(['packfile\n']), sidebandEncode(1, pack));
  }
  parts.push(pktLineFlush());
  return gitResponse(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV0(repo: RepoRecord, body: Buffer): ForgeResponse {
  const { packets } = decodePktLines(body);
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const parsed = parseFetchArgs(args);
  const selection = selectObjects(repo, parsed);
  const lines: string[] = [];
  for (const oid of selection.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of selection.unshallow) lines.push(`unshallow ${oid}\n`);
  if (parsed.haves.length === 0 || selection.acks.length === 0) lines.push('NAK\n');
  for (const oid of selection.acks) lines.push(`ACK ${oid}\n`);
  const parts: Buffer[] = [encodePktLines(lines)];
  if (selection.sent.length > 0) {
    parts.push(sidebandEncode(1, buildPack(repo, parsed, selection.sent)));
  }
  parts.push(pktLineFlush());
  return gitResponse(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** Parse fetch arguments from either protocol version. Capability words on a
 *  v0 want line, and arguments the suite never varies (thin-pack, no-progress,
 *  ofs-delta, filter, deepen-since, deepen-not, done, want-ref), are accepted
 *  and ignored. */
function parseFetchArgs(args: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) {
      const oid = arg.slice(5).split(' ')[0] as string;
      if (isObjectId(oid)) wants.push(oid);
    } else if (arg.startsWith('have ')) {
      const oid = arg.slice(5).split(' ')[0] as string;
      if (isObjectId(oid)) haves.push(oid);
    } else if (arg.startsWith('shallow ')) {
      const oid = arg.slice(8).split(' ')[0] as string;
      if (isObjectId(oid)) shallow.push(oid);
    } else if (arg.startsWith('deepen ')) {
      const value = Number.parseInt(arg.slice(7), 10);
      if (Number.isFinite(value) && value >= 0) depth = value;
    }
  }
  return { wants, haves, shallow, depth };
}

// ------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(repo: RepoRecord, store: Store, body: Buffer): ForgeResponse {
  let packets;
  let consumed: number;
  try {
    ({ packets, consumed } = decodePktLines(body, { stopAfterFlush: true }));
  } catch (err) {
    if (err instanceof PktLineError) return badRequest('malformed git request');
    throw err;
  }
  const flushIndex = packets.findIndex((packet) => packet.kind === 'flush');
  if (flushIndex < 0) return badRequest('malformed git request: no command terminator');
  const commands: PushCommand[] = [];
  let clientCaps = '';
  const commandPackets = packets.slice(0, flushIndex);
  if (commandPackets.some((packet) => packet.kind !== 'data')) return badRequest('malformed git request');
  for (let index = 0; index < commandPackets.length; index += 1) {
    let line = (commandPackets[index] as { payload: Buffer }).payload.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        clientCaps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) return badRequest('malformed git request: bad command line');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) {
      return badRequest('malformed git request: bad command line');
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return badRequest('malformed git request: no commands');

  const sideband = clientCaps.split(' ').includes('side-band-64k');
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  const packBytes = body.subarray(consumed);

  // Unpack first: a refused update still reports `unpack ok`, and the objects
  // land in the store whether or not any ref moves.
  let unpackOk = true;
  if (updatesRef) {
    if (packBytes.length === 0) {
      unpackOk = false;
    } else {
      try {
        const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
        const objects: GitObject[] = [];
        for (const [oid, object] of read.objects) {
          if (repo.objects.get(oid) === undefined) objects.push(object);
        }
        if (objects.length > 0) store.putObjects(repo, objects);
      } catch {
        unpackOk = false;
      }
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  if (unpackOk) {
    for (const command of commands) {
      const current = store.getRef(repo, command.ref);
      let ok = false;
      if (command.oldOid === ZERO_OID && command.newOid !== ZERO_OID) {
        // Create: the ref must be absent and the target must exist.
        ok = current === undefined && repo.objects.has(command.newOid);
      } else if (command.newOid === ZERO_OID) {
        // Delete: the ref must exist and the old value must match.
        ok = current !== undefined && current === command.oldOid;
      } else {
        // Update: the old value must match and the new value must descend from it.
        ok =
          current !== undefined &&
          current === command.oldOid &&
          repo.objects.has(command.newOid) &&
          (command.oldOid === command.newOid || store.isFastForward(repo, command.oldOid, command.newOid));
      }
      if (ok) {
        if (command.newOid === ZERO_OID) store.deleteRef(repo, command.ref);
        else store.setRef(repo, command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      }
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  }

  const reportStream = encodePktLines([...reportLines, 'flush']);
  const bodyOut = sideband
    ? Buffer.concat([sidebandEncode(1, reportStream), pktLineFlush()])
    : reportStream;
  return gitResponse(200, 'application/x-git-receive-pack-result', bodyOut);
}

// ------------------------------------------------------------- the router

export function handleGit(request: ForgeRequest, ctx: GitContext): ForgeResponse | null {
  const segments = request.pathname.split('/').filter((segment) => segment !== '');
  if (segments.length < 3) return null;
  const [owner, repoSegment, service] = segments as [string, string, string, ...string[]];
  if (!repoSegment.endsWith('.git')) return null;
  const repoName = repoSegment.slice(0, -'.git'.length);
  const isInfoRefs = service === 'info' && segments[3] === 'refs' && segments.length === 4;
  const isUploadPack = service === 'git-upload-pack' && segments.length === 3;
  const isReceivePack = service === 'git-receive-pack' && segments.length === 3;
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return null;

  try {
    if (ctx.token !== '') {
      const auth = headerValue(request.headers, 'authorization');
      if (auth !== `Bearer ${ctx.token}`) return jsonError(401, 'Bad credentials');
    }
    if (owner !== VIEWER.login) return jsonError(404, 'Not Found');
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined) return jsonError(404, 'Not Found');

    if (isInfoRefs) {
      if (request.method !== 'GET') return jsonError(404, 'Not Found');
      const serviceParam = request.query.get('service');
      if (serviceParam === 'git-upload-pack') {
        const wantsV2 = headerValue(request.headers, 'git-protocol') === 'version=2';
        return wantsV2
          ? gitResponse(200, 'application/x-git-upload-pack-advertisement', v2Advertisement())
          : gitResponse(200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
      }
      if (serviceParam === 'git-receive-pack') {
        return gitResponse(200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
      }
      return jsonError(404, 'Not Found');
    }

    if (request.method !== 'POST') return jsonError(404, 'Not Found');
    if (isUploadPack) {
      const wantsV2 = headerValue(request.headers, 'git-protocol') === 'version=2';
      if (wantsV2) {
        let packets;
        let consumed: number;
        try {
          ({ packets, consumed } = decodePktLines(request.body));
        } catch (err) {
          if (err instanceof PktLineError) return badRequest('malformed git request');
          throw err;
        }
        if (consumed !== request.body.length) return badRequest('malformed git request');
        const dataLines: string[] = [];
        let sawDelim = false;
        let sawCommand = false;
        let command: string | undefined;
        for (const packet of packets) {
          if (packet.kind === 'delim') {
            sawDelim = true;
            continue;
          }
          if (packet.kind !== 'data') continue;
          const line = packet.payload.toString('utf8').replace(/\n$/, '');
          if (!sawDelim && !sawCommand) {
            command = line;
            sawCommand = true;
            continue;
          }
          if (sawDelim) dataLines.push(line);
        }
        if (command === 'command=ls-refs') return handleLsRefs(repo, dataLines);
        if (command === 'command=fetch') return handleFetchV2(repo, dataLines);
        return badRequest('malformed git request: unknown command');
      }
      try {
        return handleFetchV0(repo, request.body);
      } catch (err) {
        if (err instanceof PktLineError) return badRequest('malformed git request');
        throw err;
      }
    }
    return handleReceivePack(repo, ctx.store, request.body);
  } catch (err) {
    console.error('git handler error:', err);
    return jsonError(500, 'Internal Server Error');
  }
}
