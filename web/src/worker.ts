/// <reference lib="webworker" />
import { decode, fillCoords, profile, search } from './search.ts';
import type { Payload } from './types.ts';

let meta: Payload;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    meta = msg.meta;
    decode(msg.bin, msg.meta, msg.score);
    (self as unknown as Worker).postMessage({
      type: 'ready',
      chains: meta.chains.length,
    });
  } else if (msg.type === 'query') {
    const t = performance.now();
    const { candidates, scanned, truncated } = search(msg.query);

    // Everything found is returned; nothing is dropped, and the list renders in
    // chunks as you scroll instead of being capped.
    //
    // Grouping deliberately does not happen here. The main thread has to group
    // again anyway — its "limit to map view" and "hide logged" toggles change the
    // membership without re-querying — and grouping twice cost 411 ms of the
    // 1.5 s at the loosest settings the sliders allow, for a result whose only
    // surviving use was a count.
    for (const c of candidates) fillCoords(c);

    (self as unknown as Worker).postMessage({
      type: 'results',
      id: msg.id,
      candidates,
      scanned,
      truncated,
      totalReaches: candidates.length,
      ms: performance.now() - t,
    });
  } else if (msg.type === 'profile') {
    (self as unknown as Worker).postMessage({
      type: 'profile',
      id: msg.id,
      points: profile(msg.chain, msg.i, msg.j),
    });
  }
};
