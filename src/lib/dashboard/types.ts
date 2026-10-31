export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /**
   * Raw interpolation values for the feed's ICU message, keyed by
   * `kind` (see `buildText` in activity-feed.tsx) — never
   * pre-formatted text.
   *
   * Upstream formats the sentence here instead, with `getT`. That works
   * upstream because its locale is fixed at build time, but this fork
   * resolves the locale per request from the NEXT_LOCALE cookie, and
   * `loadActivity` runs in the browser (the dashboard is a client
   * component) where `getT` can only see the build-time catalogue. So
   * the row has to reach the component untranslated.
   */
  params: Record<string, string | number | boolean | null>
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  href?: string
}
