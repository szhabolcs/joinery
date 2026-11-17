/**
 * A thin typed client over the HTTP API.
 *
 * It calls through the `api` route map from `@joinery/core` for method, path,
 * and request/response schemas, so a route or payload change in core is a
 * compile error here, not a runtime 404.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  api,
  errorResponseSchema,
  type ApiOperation,
  type BodyOf,
  type ErrorResponse,
  type ResponseOf,
} from '@joinery/core';
import type { AgentModel, DiffQuery } from '@joinery/core';
import { configuredPort, dataDirRoot } from '@joinery/server/runtime';

/** A structured API error: the server's `{code, message, hint}` shape. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ErrorResponse['error']['code'];
  readonly hint: string | undefined;

  constructor(code: ErrorResponse['error']['code'], message: string, hint: string | undefined) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

// --- configuration: base URL and bearer token ---

export function baseUrl(): string {
  return process.env['JOINERY_URL'] ?? `http://127.0.0.1:${String(configuredPort())}`;
}

/** The data directory shared with the server (see `@joinery/server/runtime`). */
export function dataDir(): string {
  return dataDirRoot();
}

let cachedToken: string | undefined;

function readToken(): string {
  if (cachedToken !== undefined) return cachedToken;
  const tokenPath = join(dataDir(), 'token');
  let raw: string;
  try {
    raw = readFileSync(tokenPath, 'utf8');
  } catch {
    throw new ApiError(
      'unauthorized',
      `could not read bearer token at ${tokenPath}`,
      'start the joinery server first, or set JOINERY_DATA_DIR to a data/ directory containing a token file',
    );
  }
  cachedToken = raw.trim();
  return cachedToken;
}

// --- low-level request plumbing ---

/**
 * `api[op].path` is typed `(...args: never[]) => string` at the `Api` map
 * level (core's `RouteDef`), so real path arguments (e.g. a review id) are
 * not callable through it without a cast. The cast is confined to this one
 * helper; every route still comes from `api`, so a renamed route is still a
 * compile error at the call sites below.
 */
async function send<K extends ApiOperation>(
  op: K,
  opts: { path: string; body?: unknown; query?: Readonly<Record<string, string | undefined>> },
): Promise<ResponseOf<K>> {
  const routeDef = api[op];
  const url = new URL(opts.path, baseUrl());
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  const hasBody = opts.body !== undefined;
  // Resolved before the try below so a local token-read failure surfaces as
  // its own `unauthorized` ApiError, not a generic network-failure one.
  const authorization = `Bearer ${readToken()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: routeDef.method,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        authorization,
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      'internal',
      `could not reach the joinery server at ${baseUrl()}: ${reason}`,
      'is the server running? check JOINERY_URL if it is not on the default port',
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const parsedErr = errorResponseSchema.safeParse(json);
    if (parsedErr.success) {
      throw new ApiError(parsedErr.data.error.code, parsedErr.data.error.message, parsedErr.data.error.hint);
    }
    throw new ApiError('internal', `request failed with HTTP ${res.status}`, undefined);
  }

  const parsed = routeDef.response.safeParse(json);
  if (!parsed.success) {
    throw new ApiError('internal', `unexpected response shape from server: ${parsed.error.message}`, undefined);
  }
  return parsed.data as ResponseOf<K>;
}

// --- one wrapper per route ---

export function listRepos(): Promise<ResponseOf<'listRepos'>> {
  return send('listRepos', { path: api.listRepos.path() });
}

export function addRepo(body: BodyOf<'addRepo'>): Promise<ResponseOf<'addRepo'>> {
  return send('addRepo', { path: api.addRepo.path(), body });
}

export function listReviews(): Promise<ResponseOf<'listReviews'>> {
  return send('listReviews', { path: api.listReviews.path() });
}

export function createReview(body: BodyOf<'createReview'>): Promise<ResponseOf<'createReview'>> {
  return send('createReview', { path: api.createReview.path(), body });
}

export function getReview(id: string): Promise<ResponseOf<'getReview'>> {
  return send('getReview', { path: api.getReview.path(id) });
}

export function getFiles(id: string): Promise<ResponseOf<'getFiles'>> {
  return send('getFiles', { path: api.getFiles.path(id) });
}

export function getDiff(id: string, query: DiffQuery): Promise<ResponseOf<'getDiff'>> {
  return send('getDiff', {
    path: api.getDiff.path(id),
    query: { path: query.path, rev: query.rev },
  });
}

export function getReadingOrder(id: string): Promise<ResponseOf<'getReadingOrder'>> {
  return send('getReadingOrder', { path: api.getReadingOrder.path(id) });
}

export function setReadingOrder(
  id: string,
  body: BodyOf<'setReadingOrder'>,
): Promise<ResponseOf<'setReadingOrder'>> {
  return send('setReadingOrder', { path: api.setReadingOrder.path(id), body });
}

export function generateReadingOrder(id: string, model?: AgentModel): Promise<ResponseOf<'generateReadingOrder'>> {
  return send('generateReadingOrder', { path: api.generateReadingOrder.path(id), body: model === undefined ? {} : { model } });
}

export function listThreads(
  id: string,
  opts: { unresolved?: boolean } = {},
): Promise<ResponseOf<'listThreads'>> {
  return send('listThreads', {
    path: api.listThreads.path(id),
    query: { status: opts.unresolved === true ? 'open' : undefined },
  });
}

export function createThread(id: string, body: BodyOf<'createThread'>): Promise<ResponseOf<'createThread'>> {
  return send('createThread', { path: api.createThread.path(id), body });
}

export function getThread(id: string): Promise<ResponseOf<'getThread'>> {
  return send('getThread', { path: api.getThread.path(id) });
}

export function reply(id: string, body: BodyOf<'reply'>): Promise<ResponseOf<'reply'>> {
  return send('reply', { path: api.reply.path(id), body });
}

export function resolveThread(
  id: string,
  body: BodyOf<'resolveThread'> = { resolved: true },
): Promise<ResponseOf<'resolveThread'>> {
  return send('resolveThread', { path: api.resolveThread.path(id), body });
}

export function deleteThread(id: string): Promise<ResponseOf<'deleteThread'>> {
  return send('deleteThread', { path: api.deleteThread.path(id) });
}

export function getComment(id: string): Promise<ResponseOf<'getComment'>> {
  return send('getComment', { path: api.getComment.path(id) });
}

export function deleteComment(id: string): Promise<ResponseOf<'deleteComment'>> {
  return send('deleteComment', { path: api.deleteComment.path(id) });
}

export function setRevision(id: string, body: BodyOf<'setRevision'>): Promise<ResponseOf<'setRevision'>> {
  return send('setRevision', { path: api.setRevision.path(id), body });
}

export function markViewed(id: string, path: string): Promise<ResponseOf<'markViewed'>> {
  return send('markViewed', { path: api.markViewed.path(id), body: { path, viewed: true } });
}

export function getRun(id: string): Promise<ResponseOf<'getRun'>> {
  return send('getRun', { path: api.getRun.path(id) });
}

export function cancelRun(id: string): Promise<ResponseOf<'cancelRun'>> {
  return send('cancelRun', { path: api.cancelRun.path(id) });
}

export function setReaction(id: string, body: BodyOf<'setReaction'>): Promise<ResponseOf<'setReaction'>> {
  return send('setReaction', { path: api.setReaction.path(id), body });
}

/** Exposed for tests: clears the cached bearer token between cases. */
export function _resetTokenCache(): void {
  cachedToken = undefined;
}

export function getReviewOrder(): Promise<ResponseOf<'getReviewOrder'>> {
  return send('getReviewOrder', { path: api.getReviewOrder.path() });
}

export function setReviewOrder(body: BodyOf<'setReviewOrder'>): Promise<ResponseOf<'setReviewOrder'>> {
  return send('setReviewOrder', { path: api.setReviewOrder.path(), body });
}
