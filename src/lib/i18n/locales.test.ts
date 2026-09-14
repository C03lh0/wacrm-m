import { describe, it, expect } from 'vitest';

import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  isKnownLocale,
  resolveLocale,
} from './locales';

describe('SUPPORTED_LOCALES', () => {
  it('exposes en, pt and es in the UI switcher', () => {
    expect(SUPPORTED_LOCALES.map((option) => option.code)).toEqual([
      'en',
      'pt',
      'es',
    ]);
  });
});

describe('isSupportedLocale', () => {
  it('accepts en, pt and es', () => {
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('pt')).toBe(true);
    expect(isSupportedLocale('es')).toBe(true);
  });

  it('accepts the legacy pt-BR spelling still sitting in browsers', () => {
    expect(isSupportedLocale('pt-BR')).toBe(true);
  });

  it('rejects ko (known, but not UI-supported) and garbage', () => {
    expect(isSupportedLocale('ko')).toBe(false);
    expect(isSupportedLocale('fr')).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
  });
});

describe('isKnownLocale', () => {
  it('accepts en, pt, es and ko', () => {
    expect(isKnownLocale('en')).toBe(true);
    expect(isKnownLocale('pt')).toBe(true);
    expect(isKnownLocale('es')).toBe(true);
    expect(isKnownLocale('ko')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isKnownLocale('fr')).toBe(false);
    expect(isKnownLocale(undefined)).toBe(false);
  });
});

describe('resolveLocale', () => {
  it('prefers a UI-supported cookie over the env var', () => {
    expect(resolveLocale('pt', 'en')).toBe('pt');
    expect(resolveLocale('es', 'en')).toBe('es');
  });

  it('folds a legacy pt-BR cookie onto pt instead of resetting to English', () => {
    // The fork shipped pt-BR.json before upstream added pt.json, so
    // anyone who picked Portuguese back then still has this on file.
    expect(resolveLocale('pt-BR', 'en')).toBe('pt');
    expect(resolveLocale(undefined, 'pt-BR')).toBe('pt');
  });

  it('falls back to the env var when the cookie is missing', () => {
    expect(resolveLocale(undefined, 'pt')).toBe('pt');
  });

  it('lets the env var resolve to ko even though the cookie could never be ko', () => {
    expect(resolveLocale(undefined, 'ko')).toBe('ko');
  });

  it('ignores an unsupported cookie value and falls back to the env var', () => {
    expect(resolveLocale('fr', 'pt')).toBe('pt');
  });

  it('falls back to DEFAULT_LOCALE when both are missing or invalid', () => {
    expect(resolveLocale(undefined, undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('fr', 'de')).toBe(DEFAULT_LOCALE);
  });
});
