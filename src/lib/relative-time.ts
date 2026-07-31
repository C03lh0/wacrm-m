/**
 * Locale-aware "X ago" formatting, shared by any feed that shows a
 * relative timestamp (dashboard activity feed, notifications). Buckets
 * into seconds/minutes/hours/days via ICU messages the caller provides
 * (`timeS`/`timeM`/`timeH`/`timeD` under whichever namespace `t` is
 * scoped to), falling back to a locale-formatted absolute date past 30
 * days — no date-fns dependency needed.
 */
export function relativeTime(
  iso: string,
  t: (key: string, values?: Record<string, number>) => string
): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return t('timeS', { sec: Math.max(1, diffSec) });
  if (diffSec < 3600) return t('timeM', { min: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return t('timeH', { hr: Math.floor(diffSec / 3600) });
  if (diffSec < 2_592_000)
    return t('timeD', { day: Math.floor(diffSec / 86400) });
  return new Date(iso).toLocaleDateString();
}
