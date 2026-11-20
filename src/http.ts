// Shared HTTP plumbing for the forge's surfaces: the request/response shapes
// every handler speaks, the JSON envelope, and the Link-header pagination
// GitHub's list endpoints use.

export interface ForgeRequest {
  readonly method: string;
  /** The path, percent-decoding left to the handler (segments decode individually). */
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

export interface ForgeResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function jsonResponse(status: number, value: unknown, extraHeaders: Record<string, string> = {}): ForgeResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

export function jsonError(status: number, message: string): ForgeResponse {
  return jsonResponse(status, { message });
}

export function emptyResponse(status: number, extraHeaders: Record<string, string> = {}): ForgeResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }, body: Buffer.alloc(0) };
}

/** Parse a request body as JSON. Empty bodies read as null; malformed JSON throws. */
export function parseJsonBody(request: ForgeRequest): unknown {
  if (request.body.length === 0) return null;
  const text = request.body.toString('utf8');
  if (text.trim() === '') return null;
  return JSON.parse(text) as unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stringField(body: unknown, name: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

/** Split a path into segments, percent-decoding each one. Empty segments are dropped. */
export function pathSegments(pathname: string): string[] {
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      segments.push(raw);
    }
  }
  return segments;
}

export interface PageParams {
  readonly page: number;
  readonly perPage: number;
}

/** GitHub's pagination parameters: page (default 1), per_page (default 30, capped at 100). */
export function pageParams(query: URLSearchParams): PageParams {
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  return { page, perPage };
}

export interface Paged<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
}

export function paginate<T>(all: readonly T[], params: PageParams): Paged<T> {
  const start = (params.page - 1) * params.perPage;
  return {
    items: all.slice(start, start + params.perPage),
    total: all.length,
    page: params.page,
    perPage: params.perPage,
  };
}

/**
 * The Link header for a paged list: absolute same-origin URLs built from the
 * request's Host header, with rel next/prev/first/last as they apply.
 */
export function linkHeader(request: ForgeRequest, paged: Paged<unknown>): string | undefined {
  const host = headerValue(request.headers, 'host');
  if (host === undefined || host === '') return undefined;
  const totalPages = Math.max(1, Math.ceil(paged.total / paged.perPage));
  const links: string[] = [];
  const urlFor = (page: number): string => {
    const query = new URLSearchParams(request.query);
    query.set('page', String(page));
    query.set('per_page', String(paged.perPage));
    const queryText = query.toString();
    return `http://${host}${request.pathname}${queryText === '' ? '' : `?${queryText}`}`;
  };
  if (paged.page < totalPages) links.push(`<${urlFor(paged.page + 1)}>; rel="next"`);
  if (paged.page > 1) links.push(`<${urlFor(paged.page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return links.join(', ');
}
