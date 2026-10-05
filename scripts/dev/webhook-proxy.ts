import http from 'node:http';
import { isIP } from 'node:net';

// The local proxy between cloudflared and the dev api (README, decision
// #071). It forwards only /webhooks/*, so the tunnel never exposes login,
// registration or the rest of the api. Like Caddy on staging (#057) it is
// the one proxy hop the api trusts (API_TRUST_PROXY=1): it overwrites
// X-Forwarded-For with the client IP Cloudflare puts in Cf-Connecting-Ip.
// The body is streamed untouched, so signatures over the raw body still match.

/** Headers a client could use to pose as another address or origin. */
const dropped = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'connection',
  'keep-alive',
  'proxy-connection',
]);

/** The path to forward, or null if the request may not pass. Dot segments are resolved first. */
export function webhookPath(rawUrl: string | undefined): string | null {
  if (!rawUrl?.startsWith('/')) return null;
  const url = new URL(rawUrl, 'http://tunnel.invalid');
  return url.pathname.startsWith('/webhooks/') ? url.pathname + url.search : null;
}

export function createWebhookProxy(api: { host: string; port: number }): http.Server {
  return http.createServer((request, response) => {
    const path = webhookPath(request.url);
    if (!path) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found\n');
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!dropped.has(name)) headers[name] = value;
    }
    const client = request.headers['cf-connecting-ip'];
    if (typeof client === 'string' && isIP(client)) headers['x-forwarded-for'] = client;
    headers['x-forwarded-proto'] = 'https';

    const upstream = http.request(
      { host: api.host, port: api.port, method: request.method, path, headers },
      (apiResponse) => {
        response.writeHead(apiResponse.statusCode ?? 502, apiResponse.headers);
        apiResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('Local api unreachable\n');
    });
    request.pipe(upstream);
  });
}
