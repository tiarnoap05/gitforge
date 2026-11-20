// Identity and time for the forge: who the bearer token names, and the only
// clock the server may use. Both are derived, never read from the wall.
//
// The viewer: the suite's scenario is public and fixed (the kit's wire.ts
// settles the seed and the generators, and the rules say nothing is hidden),
// so the entry derives the token owner's login with the same algorithm the
// suite uses to build its data: FNV-1a + splitmix64 seeding, an xorshift64*
// stream labelled 'users', twelve generated users, the first one the viewer.
// The derived values are verified by the local test run, which must print
// login `adaiversen`, id 1000.
//
// The clock: MAKEFUN_TRIAL_NOW is the trial's fixed now, an RFC 3339 instant
// or epoch milliseconds. Every timestamp the forge emits comes from it plus
// a monotonic counter, so two runs of the same request sequence produce the
// same timestamps and the replay export stays byte-identical. When the
// variable is absent (a local run outside a trial) the clock falls back to
// a fixed constant, never to the wall clock.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a, 64-bit: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64*: the scenario's deterministic stream. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

export interface ForgeUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

function generateUsers(count: number): ForgeUser[] {
  const seed = mix64(SCENARIO_SEED ^ fnv1a64('users'));
  const rng = new Rng(seed);
  const used = new Set<string>();
  const users: ForgeUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = generateUsers(12);

/** The login the bearer token names: the scenario's first user. */
export const VIEWER: ForgeUser = USERS[0] as ForgeUser;
/** A second user, for nothing the forge serves (kept so the derivation stays whole). */
export const STRANGER: ForgeUser = USERS[2] as ForgeUser;

// ---------------------------------------------------------------- the trial clock

/** The fallback now when MAKEFUN_TRIAL_NOW is absent: fixed, never the wall clock. */
const FALLBACK_NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Parse MAKEFUN_TRIAL_NOW: an RFC 3339 instant or epoch milliseconds. Anything
 * else falls back to the fixed constant, so a missing variable can never make
 * the forge read the wall clock.
 */
export function parseTrialNow(text: string | undefined): number {
  if (text === undefined || text === '') return FALLBACK_NOW_MS;
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    if (Number.isFinite(ms) && ms > 0) return ms;
    return FALLBACK_NOW_MS;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : FALLBACK_NOW_MS;
}

/**
 * The forge's only clock: the trial's fixed now plus one second per tick. Every
 * timestamp handed out is strictly later than the last, and the sequence is a
 * pure function of the request order, so a replay emits the same timestamps.
 */
export class TrialClock {
  readonly baseMs: number;
  #tick = 0;

  constructor(nowMs: number) {
    this.baseMs = nowMs;
  }

  /** The next timestamp: base + tick seconds, as epoch milliseconds. */
  nextMs(): number {
    this.#tick += 1;
    return this.baseMs + this.#tick * 1000;
  }

  /** The next timestamp as an ISO-8601 string (REST created_at / updated_at). */
  nextIso(): string {
    return new Date(this.nextMs()).toISOString();
  }

  /** The next timestamp as epoch seconds (git author/committer lines). */
  nextSec(): number {
    return Math.floor(this.nextMs() / 1000);
  }

  /** The trial's opening instant, unticked, as an ISO string. */
  baseIso(): string {
    return new Date(this.baseMs).toISOString();
  }
}

// ---------------------------------------------------------------- request ids

let requestCounter = 0;

/** The next X-GitHub-Request-Id: deterministic for an identical request order. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `gf-${requestCounter}`;
}
