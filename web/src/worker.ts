/// <reference lib="webworker" />
import { decode, fillCoords, profile, search } from './search.ts';
import { buildGroups } from './grouping.ts';
import type { GroupModel } from './grouping.ts';
import type { Payload } from './types.ts';

let meta: Payload;
let groupModel: GroupModel | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'init') {
    meta = msg.meta;
    groupModel = msg.groupModel ?? null;
    decode(msg.bin, msg.meta, msg.score);
    (self as unknown as Worker).postMessage({
      type: 'ready',
      chains: meta.chains.length,
    });
  } else if (msg.type === 'query') {
    const t = performance.now();
    const { candidates, scanned, truncated } = search(msg.query);

    // Everything found is returned: ranking happens here so the main thread gets
    // reaches already ordered by watercourse, but nothing is dropped. The list
    // renders in chunks as you scroll instead of being capped.
    const groups = buildGroups(candidates, msg.query.sort, meta.spacing, groupModel);
    const ordered = groups.flatMap((g) => g.members.map(fillCoords));

    (self as unknown as Worker).postMessage({
      type: 'results',
      id: msg.id,
      candidates: ordered,
      scanned,
      truncated,
      totalGroups: groups.length,
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
