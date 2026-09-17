import type { Message } from "@/types";

/**
 * Combine a freshly fetched page of messages with what the thread
 * already has in memory.
 *
 * The thread used to fetch a conversation's entire history in one
 * unbounded ascending query and replace state with the result. That was
 * wrong twice over: PostgREST caps responses at `db-max-rows`, so an
 * unbounded ascending query returns the OLDEST rows and drops the newest
 * ones, and a blind replace also discards anything realtime appended
 * while the query was in flight.
 *
 * The fetch is now a bounded newest-first page, which means merging is
 * mandatory rather than an optimisation: older pages the user scrolled
 * back to must survive the next resync, and a realtime INSERT that lands
 * mid-query must not be thrown away.
 *
 * Order-independent — the same function serves the initial page, an
 * older page, and a resync.
 */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  if (existing.length === 0) return [...incoming];
  if (incoming.length === 0) return [...existing];

  const byId = new Map(existing.map((m) => [m.id, m]));
  // Incoming wins on conflict: it is the newer read of the same row, so
  // it carries any status change the in-memory copy predates.
  for (const msg of incoming) byId.set(msg.id, msg);

  return [...byId.values()].sort(compareMessages);
}

/**
 * Oldest first, which is render order.
 *
 * The id tiebreak is not cosmetic: two messages can share a
 * `created_at` to the millisecond (a burst delivered in one webhook
 * batch), and without a deterministic second key the list reshuffles on
 * every merge — rows visibly swapping places as unrelated messages
 * arrive.
 */
function compareMessages(a: Message, b: Message): number {
  const delta = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  return delta !== 0 ? delta : a.id.localeCompare(b.id);
}

/**
 * Narrow a thread's in-memory messages to the conversation a fetched
 * page belongs to, dropping optimistic rows.
 *
 * Switching conversations must replace, never accumulate — merging
 * across threads would leak one contact's messages into another's, and
 * the thread is keyed only by the conversation id it was asked to load.
 *
 * Optimistic `temp-` rows are dropped because the fetched page is the
 * authoritative read; the realtime INSERT that confirms a send brings
 * the real row back with its real id.
 */
export function messagesForThread(
  messages: Message[],
  conversationId: string
): Message[] {
  return messages.filter(
    (m) => m.conversation_id === conversationId && !m.id.startsWith("temp-")
  );
}
