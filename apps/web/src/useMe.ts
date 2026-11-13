import { useEffect, useState } from 'react';
import { api, type Identity } from './api';
import { getOperatorName, onOperatorNameChange } from './operator-name';

/**
 * Who the operator is, per the server (WP 7.3). AUTH_MODE=none → whatever the
 * client claims, unverified; AUTH_MODE=header → the proxy-authenticated user,
 * verified. Fetched once and shared; components read `me.user` instead of the
 * old hardcoded 'operator' string so a gate decision or dispatch is attributed.
 *
 * When the name kept in this browser changes (#129), the answer is dropped and
 * fetched again, and every mounted useMe gets the new one without a reload.
 */
let cache: Identity | null = null;
let inflight: Promise<Identity> | null = null;
const mounted = new Set<(m: Identity) => void>();

/** What to show before /api/me answers (or if it fails): the name set here, else 'operator'. */
export function fallbackMe(): Identity {
  return { user: getOperatorName() ?? 'operator', verified: false, mode: 'none' };
}

/** The shared identity: the cached answer, or the one request in flight. */
export function loadMe(): Promise<Identity> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    const p: Promise<Identity> = api.me().then((m) => {
      if (inflight !== p) return m; // the name changed meanwhile; a newer request answers instead
      cache = m;
      for (const fn of [...mounted]) fn(m);
      return m;
    });
    p.catch(() => { if (inflight === p) inflight = null; });
    inflight = p;
  }
  return inflight;
}

/** Hear every new answer (and the fallback while a changed name is being looked up). Returns the unsubscribe. */
export function subscribeMe(fn: (m: Identity) => void): () => void {
  mounted.add(fn);
  return () => { mounted.delete(fn); };
}

// Follow the name: forget the old answer and ask again.
onOperatorNameChange(() => {
  cache = null;
  inflight = null;
  for (const fn of [...mounted]) fn(fallbackMe());
  if (mounted.size) loadMe().catch(() => {});
});

export function useMe(): Identity {
  const [me, setMe] = useState<Identity>(() => cache ?? fallbackMe());
  useEffect(() => {
    const off = subscribeMe(setMe);
    if (cache) setMe(cache);
    else loadMe().catch(() => {}); // the answer reaches setMe through the subscription
    return off;
  }, []);
  return me;
}
