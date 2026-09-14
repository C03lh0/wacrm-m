// ============================================================
// Supported locales + the pure locale-resolution rule.
//
// The dictionaries themselves (messages/*.json) are upstream's and are
// maintained there; this file is the fork's own addition — upstream
// picks a locale from NEXT_PUBLIC_APP_LOCALE at build time and has no
// runtime switcher.
//
// `SUPPORTED_LOCALES` is what the UI switcher offers. `ko` is a fourth,
// fully-translated dictionary (messages/ko.json) that keeps working for
// any installation that already sets NEXT_PUBLIC_APP_LOCALE=ko — it's
// just never offered as a choice in the switcher.
// See docs/superpowers/specs/2026-07-28-i18n-pt-br-design.md.
// ============================================================

export type Locale = 'en' | 'pt' | 'es' | 'ko';

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
  { code: 'pt', label: 'Português' },
  { code: 'es', label: 'Español' },
];

/** Every locale next-intl can render, including ones only reachable
 *  via NEXT_PUBLIC_APP_LOCALE. */
const ALL_KNOWN_LOCALES: Locale[] = ['en', 'pt', 'es', 'ko'];

/**
 * Locale spellings that are no longer canonical but are still sitting
 * in browsers. The fork shipped its own `pt-BR.json` before upstream
 * added `pt.json`; anyone who picked Portuguese back then still has
 * `NEXT_LOCALE=pt-BR` on file, and dropping it on the floor would
 * silently reset them to English.
 */
const LOCALE_ALIASES: Record<string, Locale> = {
  'pt-BR': 'pt',
  'pt-br': 'pt',
  'es-419': 'es',
};

/** Fold an alias onto its canonical locale, leaving anything else as-is. */
function canonicalize(value: string | null | undefined): string | null {
  if (!value) return null;
  return LOCALE_ALIASES[value] ?? value;
}

export function isSupportedLocale(
  value: string | null | undefined
): value is Locale {
  const code = canonicalize(value);
  return SUPPORTED_LOCALES.some((option) => option.code === code);
}

export function isKnownLocale(
  value: string | null | undefined
): value is Locale {
  return (ALL_KNOWN_LOCALES as string[]).includes(canonicalize(value) ?? '');
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
  if (isSupportedLocale(cookieValue)) return canonicalize(cookieValue) as Locale;
  if (isKnownLocale(envValue)) return canonicalize(envValue) as Locale;
  return DEFAULT_LOCALE;
}
