import type { FastifyRequest } from 'fastify';
import { resolve } from '@asf/shared';

/**
 * Who is making this request (WP 7.3). Two modes, declared by AUTH_MODE:
 *
 *   none    single-operator MVP. Identity is whatever the client claims (a name
 *           box → X-Operator header, or the `by` in a body); the badge says
 *           unverified because nothing checked it.
 *   header  an upstream proxy (Google IAP, Tailscale serve, an SSO gateway) has
 *           already authenticated the user and set AUTH_HEADER. We trust it —
 *           but only when the api is NOT directly reachable and the proxy is
 *           the only way in: either the api binds loopback/VPC, or (in a
 *           container) its port is published on loopback only, which compose
 *           tells us through API_PUBLISH_HOST. Anything else would let a direct
 *           caller spoof the header, so it is refused at boot
 *           (assertIdentityConfig).
 *
 * IAP sets X-Goog-Authenticated-User-Email to `accounts.google.com:alice@x.com`;
 * we return the bare address.
 *
 * These read the catalogue (env) at call time rather than a load-time snapshot,
 * which keeps the module free of import-order coupling and directly testable.
 */
export interface Identity { user: string; verified: boolean; mode: string }

function authMode(): string { return resolve('AUTH_MODE'); }
function authHeader(): string { return resolve('AUTH_HEADER'); }
// Same precedence as config.ts: an explicit API_HOST wins, else PORT (a container) means 0.0.0.0.
function apiHost(): string { return process.env.API_HOST ? resolve('API_HOST') : process.env.PORT ? '0.0.0.0' : resolve('API_HOST'); }
function publishHost(): string { return resolve('API_PUBLISH_HOST').trim(); }

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function resolveIdentity(req: FastifyRequest): Identity {
  if (authMode() === 'header') {
    const raw = req.headers[authHeader().toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) {
      const user = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
      return { user, verified: true, mode: 'header' };
    }
    // header mode but the proxy sent nothing — do not silently fall back to a
    // spoofable identity; report anonymous+unverified so the UI can say so.
    return { user: 'anonymous', verified: false, mode: 'header' };
  }
  // The browser percent-encodes the name (a header can't carry "Zoë" as-is); a raw value that
  // isn't valid encoding is kept as sent.
  const hdr = req.headers['x-operator'];
  const raw = Array.isArray(hdr) ? hdr[0] : hdr;
  const claimed = (raw === undefined ? undefined : decodeOperator(raw)) ?? (req.body as { by?: string } | undefined)?.by ?? 'operator';
  return { user: claimed, verified: false, mode: 'none' };
}

function decodeOperator(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/**
 * Boot-time guard: header mode is only safe when the proxy is the only way in.
 *
 * In a container the api has to bind 0.0.0.0 (the worker reaches it over the
 * compose network), so the bind address alone says nothing. What decides who
 * can reach it from outside is the host address docker publishes the port on.
 * docker-compose.self-host.yml passes that as API_PUBLISH_HOST, from the same
 * ASF_BIND expression as its `ports:` line. When it is set, it decides: loopback
 * is allowed (tailscale serve / Caddy on the host is the only way in), anything
 * else is refused. When it isn't set, the bind address decides, as before.
 */
export function assertIdentityConfig(): void {
  if (authMode() !== 'header') return;
  const published = publishHost();
  if (published) {
    if (isLoopback(published)) return;
    throw new Error(
      `AUTH_MODE=header needs the proxy to be the only way in, but the api's port is published on ${published} (ASF_BIND), ` +
      `so anyone who can reach that port could send ${authHeader()} themselves. ` +
      'Remove ASF_BIND from .env (loopback is the default) and reach ASF through tailscale serve, or use AUTH_MODE=none.',
    );
  }
  const host = apiHost();
  if (host === '0.0.0.0') {
    throw new Error(
      `AUTH_MODE=header requires the api to sit behind a proxy, but the api binds ${host} (publicly reachable). ` +
      'Bind loopback/VPC and let the proxy (IAP/Tailscale/SSO) reach it, or use AUTH_MODE=none.',
    );
  }
}
