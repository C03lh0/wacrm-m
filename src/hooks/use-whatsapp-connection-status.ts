"use client";

import { useCallback, useEffect, useState } from "react";
import type { WhatsAppConnectionStatus } from "@/lib/whatsapp/connection-status";

const DEFAULT_STATUS: WhatsAppConnectionStatus = {
  provider: null,
  connected: false,
  enforcesSessionWindow: false,
  syncing: false,
};

async function fetchStatus(): Promise<WhatsAppConnectionStatus> {
  const result = await fetch("/api/whatsapp/status", { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => null);
  return result ?? DEFAULT_STATUS;
}

/**
 * Client-side fetch of GET /api/whatsapp/status — the provider-agnostic
 * connection status (Meta vs Evolution, connected, 24h session window).
 *
 * Shared by any UI that needs to gate a Meta-only capability (template
 * pickers, interactive button/list step types) behind the account's
 * actual resolved provider — Evolution has neither, so those surfaces
 * should hide/disable rather than let the user build something that's
 * guaranteed to fail at send time.
 */
export function useWhatsAppConnectionStatus() {
  const [status, setStatus] = useState<WhatsAppConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Exposed for callers that want to force a re-check (e.g. right after
  // reconnecting). Not called from the mount effect below — the effect
  // has its own inline fetch so state updates stay scoped to a single
  // mount, cancellation-guarded body rather than routing through a
  // hoisted callback reference.
  const refresh = useCallback(async () => {
    setStatus(await fetchStatus());
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchStatus().then((result) => {
      if (cancelled) return;
      setStatus(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { status: status ?? DEFAULT_STATUS, loading, refresh };
}
