// ============================================================
// POST /api/locale
//
// Sets the NEXT_LOCALE cookie so subsequent requests render in the
// chosen language (src/i18n/request.ts reads it via resolveLocale).
// Not account-scoped, not authenticated — the locale choice is a
// per-browser UI preference, same trust level as the theme/mode
// choice already stored in localStorage. Only the UI-supported
// locales (see SUPPORTED_LOCALES) can be set this way; `ko` stays
// reachable only via NEXT_PUBLIC_APP_LOCALE.
// ============================================================

import { NextResponse } from 'next/server';

import {
  LOCALE_COOKIE,
  isSupportedLocale,
  resolveLocale,
} from '@/lib/i18n/locales';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const rawLocale = (body as { locale?: unknown } | null)?.locale;
  const locale = typeof rawLocale === 'string' ? rawLocale : undefined;

  if (!isSupportedLocale(locale)) {
    return NextResponse.json({ error: 'Unsupported locale' }, { status: 400 });
  }

  // Store the canonical spelling rather than whatever came in, so a
  // legacy alias (`pt-BR`) is healed on the way through instead of
  // being written back for another year.
  const canonical = resolveLocale(locale, undefined);

  const response = NextResponse.json({ locale: canonical });
  response.cookies.set(LOCALE_COOKIE, canonical, {
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax',
  });
  return response;
}
