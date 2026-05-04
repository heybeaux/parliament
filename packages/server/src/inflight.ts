/**
 * PAR-18 — In-flight deliberation broker.
 *
 * The server mints an id on `POST /deliberate` and runs `runTopology()` in
 * the background. While that's running, two read paths must work:
 *
 *   1. Polling: `GET /deliberate/:id` returns whatever turns/events have
 *      been persisted so far. That path reads SQLite directly and needs
 *      no help from this module.
 *   2. Streaming: `GET /deliberate/:id/stream` (SSE) emits each new turn
 *      and event as it lands, then closes the stream when the run reaches
 *      `completed` / `failed`. This module is the in-process pub/sub the
 *      streaming endpoint subscribes to.
 *
 * Design choices:
 *   - Keyed by deliberation id; many subscribers per id are supported (so
 *     a refresh while the previous tab is still streaming Just Works).
 *   - When the underlying deliberation reaches a terminal status the
 *     broker emits one final `status` event AND removes the topic, so
 *     a late subscriber that races a completion read sees no spurious
 *     reuse.
 *   - Subscribers MUST tolerate handler errors silently; the publisher
 *     swallows handler throws so a broken sink (closed SSE socket) cannot
 *     interrupt the live run.
 *   - Out-of-process scaling is out of scope. Parliament runs single-node
 *     today; if we ever shard, swap this module for a Redis pub/sub.
 */

import type {
  DeliberationStatus,
  SystemEvent,
  Turn,
  UpstreamErrorContext,
} from '@parliament/core';

export type InflightEvent =
  | { type: 'turn'; turn: Turn }
  | { type: 'event'; event: SystemEvent }
  | {
      type: 'status';
      status: DeliberationStatus;
      error?: string;
      /**
       * PAR-32 / PRD D2 — when the deliberation failed because of an
       * upstream provider error, the structured upstream context is
       * preserved here. Forwarded onto SSE consumers verbatim so callers
       * see provider, status, and body without parsing strings.
       */
      upstream?: UpstreamErrorContext;
    };

export type InflightSubscriber = (event: InflightEvent) => void;

interface Topic {
  subscribers: Set<InflightSubscriber>;
}

class InflightBroker {
  private topics = new Map<string, Topic>();

  /**
   * Subscribe to in-flight events for a deliberation id. Returns an
   * unsubscribe handle. Idempotent — subscribing twice with the same
   * function adds the function once (Set semantics).
   */
  subscribe(id: string, handler: InflightSubscriber): () => void {
    let topic = this.topics.get(id);
    if (topic === undefined) {
      topic = { subscribers: new Set() };
      this.topics.set(id, topic);
    }
    topic.subscribers.add(handler);
    return () => {
      const t = this.topics.get(id);
      if (t === undefined) return;
      t.subscribers.delete(handler);
      if (t.subscribers.size === 0) {
        this.topics.delete(id);
      }
    };
  }

  /**
   * Publish an event to every subscriber. Handler throws are swallowed —
   * a misbehaving subscriber cannot interrupt the live deliberation.
   *
   * For a `status` event with `completed` or `failed`, we fire to current
   * subscribers and then drop the topic so later subscribers cannot
   * receive a stale terminal — they'll observe the final status by
   * fetching `GET /deliberate/:id` directly (the SSE handler does this on
   * connect).
   */
  publish(id: string, event: InflightEvent): void {
    const topic = this.topics.get(id);
    if (topic === undefined) return;
    // Snapshot the subscriber set before iterating so a handler that
    // unsubscribes during dispatch doesn't mutate the live iterator.
    const handlers = [...topic.subscribers];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // intentionally silent — broker contract.
      }
    }
    if (event.type === 'status' && event.status !== 'in_flight') {
      this.topics.delete(id);
    }
  }

  /**
   * Test seam — number of currently subscribed handlers for an id.
   */
  subscriberCount(id: string): number {
    return this.topics.get(id)?.subscribers.size ?? 0;
  }

  /**
   * Test seam — drop every topic and subscriber. Vitest's `beforeEach`
   * hooks call this so cross-test state cannot leak.
   */
  reset(): void {
    this.topics.clear();
  }
}

/**
 * Module-level singleton. The router and the background runner share this
 * one instance via direct import; no DI is needed because we only have
 * one process.
 */
export const inflightBroker = new InflightBroker();
