import { describe, expect, it } from "vitest";
import { mergeMessages, messagesForThread } from "./merge-messages";
import type { Message } from "@/types";

function msg(
  id: string,
  createdAt: string,
  overrides: Partial<Message> = {}
): Message {
  return {
    id,
    conversation_id: "conv-1",
    sender_type: "customer",
    content_type: "text",
    content_text: id,
    status: "delivered",
    created_at: createdAt,
    ...overrides,
  } as Message;
}

describe("mergeMessages", () => {
  it("returns the incoming page when nothing is held yet", () => {
    const page = [msg("a", "2026-09-01T10:00:00Z")];
    expect(mergeMessages([], page)).toEqual(page);
  });

  it("keeps messages that realtime appended while the query was in flight", () => {
    // The reported symptom: a message arrives over realtime, the thread
    // refetches, and the message disappears because the fetch replaced
    // state instead of merging into it.
    const fromRealtime = msg("live", "2026-09-01T10:05:00Z");
    const fetched = [msg("a", "2026-09-01T10:00:00Z")];

    const merged = mergeMessages([fromRealtime], fetched);

    expect(merged.map((m) => m.id)).toEqual(["a", "live"]);
  });

  it("keeps older pages the user scrolled back to", () => {
    const older = [msg("old-1", "2026-08-01T10:00:00Z")];
    const newest = [msg("new-1", "2026-09-01T10:00:00Z")];

    expect(mergeMessages(older, newest).map((m) => m.id)).toEqual([
      "old-1",
      "new-1",
    ]);
  });

  it("lets the freshly fetched copy win over the one already held", () => {
    // Same row, newer read — the fetch may carry a status the
    // in-memory copy predates.
    const held = msg("a", "2026-09-01T10:00:00Z", { status: "sent" });
    const fetched = msg("a", "2026-09-01T10:00:00Z", { status: "read" });

    const merged = mergeMessages([held], [fetched]);

    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("read");
  });

  it("orders oldest first regardless of which side a message came from", () => {
    const held = [msg("c", "2026-09-01T12:00:00Z")];
    const fetched = [
      msg("b", "2026-09-01T11:00:00Z"),
      msg("a", "2026-09-01T10:00:00Z"),
    ];

    expect(mergeMessages(held, fetched).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("breaks same-timestamp ties deterministically", () => {
    // A webhook batch can deliver several messages sharing a
    // millisecond. Without a stable second key the list reshuffles on
    // every merge, which reads as rows jumping around on screen.
    const sameInstant = "2026-09-01T10:00:00.000Z";
    const first = mergeMessages(
      [msg("y", sameInstant)],
      [msg("x", sameInstant), msg("z", sameInstant)]
    );
    const second = mergeMessages(
      [msg("z", sameInstant)],
      [msg("y", sameInstant), msg("x", sameInstant)]
    );

    expect(first.map((m) => m.id)).toEqual(["x", "y", "z"]);
    expect(second.map((m) => m.id)).toEqual(first.map((m) => m.id));
  });

  it("does not mutate either input", () => {
    const held = [msg("a", "2026-09-01T10:00:00Z")];
    const fetched = [msg("b", "2026-09-01T11:00:00Z")];

    mergeMessages(held, fetched);

    expect(held).toHaveLength(1);
    expect(fetched).toHaveLength(1);
  });
});

describe("messagesForThread", () => {
  it("drops messages belonging to another conversation", () => {
    // Switching threads has to replace, never accumulate — otherwise one
    // contact's messages leak into another's thread.
    const messages = [
      msg("a", "2026-09-01T10:00:00Z", { conversation_id: "conv-1" }),
      msg("b", "2026-09-01T10:01:00Z", { conversation_id: "conv-2" }),
    ];

    expect(messagesForThread(messages, "conv-2").map((m) => m.id)).toEqual(["b"]);
  });

  it("drops optimistic rows so the fetched page stays authoritative", () => {
    const messages = [
      msg("a", "2026-09-01T10:00:00Z"),
      msg("temp-123", "2026-09-01T10:02:00Z"),
    ];

    expect(messagesForThread(messages, "conv-1").map((m) => m.id)).toEqual(["a"]);
  });

  it("returns nothing when the thread has never been loaded", () => {
    expect(messagesForThread([], "conv-1")).toEqual([]);
  });
});
