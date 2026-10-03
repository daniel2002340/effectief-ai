import type { FastifyRequest } from 'fastify';

/** Fastify's incoming headers as a Fetch API Headers object. */
export function toFetchHeaders(raw: FastifyRequest['headers']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}
