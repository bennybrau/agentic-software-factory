import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Sql } from '../db/pool.js';
import { listenNotifications, listenQueueChanges, listenRunEvents } from '../db/notify.js';
import { getEventBySeq, getEvents } from '../runs/store.js';

/**
 * GET /internal/events/runs — SSE. Every run event, as it commits, to every
 * subscriber. `Last-Event-ID` is "<runId>:<seq>"; on reconnect a client may
 * also pass ?runs=a,b to have events after that seq replayed for those runs.
 * A queue entry the scheduler moves is sent as `queue:changed` with no `id:`
 * line, so it never disturbs the run-event `Last-Event-ID`. Likewise every
 * notification row, as it commits, is sent as `notification` with no `id:` line.
 */
export async function registerStream(app: FastifyInstance, sql: Sql): Promise<() => Promise<void>> {
  const clients = new Set<FastifyReply>();
  const send = (reply: FastifyReply, event: string, id: string, data: unknown) => {
    reply.raw.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Look events up one at a time, in NOTIFY order (= commit order). Concurrent lookups
  // could resolve out of order and send seq 4 before seq 3, and a client that resumes
  // from Last-Event-ID would then skip seq 3 for good.
  let chain: Promise<void> = Promise.resolve();
  const { unlisten } = await listenRunEvents(sql, (runId, seq) => {
    chain = chain.then(async () => {
      const ev = await getEventBySeq(sql, runId, seq);
      if (!ev) return;
      for (const c of clients) send(c, 'run:event', `${runId}:${seq}`, ev);
    }).catch(() => {}); // one failed lookup must not stall the stream
  });
  const queue = await listenQueueChanges(sql, (id, state) => {
    const frame = `event: queue:changed\ndata: ${JSON.stringify({ id, state })}\n\n`;
    for (const c of clients) c.raw.write(frame);
  });
  const notifications = await listenNotifications(sql, (id, kind) => {
    const frame = `event: notification\ndata: ${JSON.stringify({ id, kind })}\n\n`;
    for (const c of clients) c.raw.write(frame);
  });

  app.get<{ Querystring: { runs?: string } }>('/internal/events/runs', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    reply.raw.write(`event: hello\ndata: {}\n\n`);
    // Replay on reconnect.
    const last = req.headers['last-event-id'];
    if (typeof last === 'string' && req.query.runs) {
      const idx = last.lastIndexOf(':');
      const afterSeq = idx > 0 ? Number(last.slice(idx + 1)) : 0;
      for (const runId of req.query.runs.split(',')) {
        for (const ev of await getEvents(sql, runId, afterSeq, 1000)) send(reply, 'run:event', `${runId}:${ev.seq}`, ev);
      }
    }
    clients.add(reply);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(ping); clients.delete(reply); });
    await new Promise(() => {}); // held open until the client disconnects
  });

  return async () => { await unlisten(); await queue.unlisten(); await notifications.unlisten(); for (const c of clients) c.raw.end(); };
}
