// ============================================================
// Supported locales + the pure locale-resolution rule.
//
// `SUPPORTED_LOCALES` is what the UI switcher offers. `ko` is a
// third, fully-translated dictionary (messages/ko.json) that keeps
// working for any installation that already sets
// NEXT_PUBLIC_APP_LOCALE=ko — it's just never offered as a choice
// in the switcher. See docs/superpowers/specs/2026-07-28-i18n-pt-br-design.md.
// ============================================================

export type Locale = 'en' | 'pt-BR' | 'ko';

export interface LocaleOption {
  code: Locale;
  label: string;
}

export const DEFAULT_LOCALE: Locale = 'en';

/** Cookie name next-intl conventionally reads/writes for the active locale. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/**
 * Locales offered in the UI switcher (Settings → Appearance, header
 * menu). `label` is each language's own name for itself — shown
 * as-is regardless of the currently active locale, so it is not
 * translated via next-intl.
 */
export const SUPPORTED_LOCALES: LocaleOption[] = [
  { code: 'en', label: 'English' },
  { code: 'pt-BR', label: 'Português' },
];

/** Every locale next-intl can render, including ones only reachable
 *  via NEXT_PUBLIC_APP_LOCALE. */
const ALL_KNOWN_LOCALES: Locale[] = ['en', 'pt-BR', 'ko'];

export function isSupportedLocale(
  value: string | null | undefined
): value is Locale {
  return SUPPORTED_LOCALES.some((option) => option.code === value);
}

export function isKnownLocale(
  value: string | null | undefined
): value is Locale {
  return (ALL_KNOWN_LOCALES as string[]).includes(value ?? '');
}

/**
 * Resolve which locale a request should render in.
 *
 * Priority: cookie (must be a UI-supported locale) > env var (may be
 * any known locale, so NEXT_PUBLIC_APP_LOCALE=ko keeps working even
 * though ko isn't offered in the switcher) > DEFAULT_LOCALE.
 */
export function resolveLocale(
  cookieValue: string | null | undefined,
  envValue: string | null | undefined
): Locale {
  if (isSupportedLocale(cookieValue)) return cookieValue;
  if (isKnownLocale(envValue)) return envValue;
  return DEFAULT_LOCALE;
}
