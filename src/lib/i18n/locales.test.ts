import { describe, it, expect } from 'vitest';

import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  isKnownLocale,
  resolveLocale,
} from './locales';

describe('SUPPORTED_LOCALES', () => {
  it('only exposes en and pt-BR in the UI switcher', () => {
    expect(SUPPORTED_LOCALES.map((option) => option.code)).toEqual([
      'en',
      'pt-BR',
    ]);
  });
});

describe('isSupportedLocale', () => {
  it('accepts en and pt-BR', () => {
    expect(isSupportedLocale('en')).toBe(true);
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
  it('accepts en, pt-BR, and ko', () => {
    expect(isKnownLocale('en')).toBe(true);
    expect(isKnownLocale('pt-BR')).toBe(true);
    expect(isKnownLocale('ko')).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isKnownLocale('fr')).toBe(false);
    expect(isKnownLocale(undefined)).toBe(false);
  });
});

describe('resolveLocale', () => {
  it('prefers a UI-supported cookie over the env var', () => {
    expect(resolveLocale('pt-BR', 'en')).toBe('pt-BR');
  });

  it('falls back to the env var when the cookie is missing', () => {
    expect(resolveLocale(undefined, 'pt-BR')).toBe('pt-BR');
  });

  it('lets the env var resolve to ko even though the cookie could never be ko', () => {
    expect(resolveLocale(undefined, 'ko')).toBe('ko');
  });

  it('ignores an unsupported cookie value and falls back to the env var', () => {
    expect(resolveLocale('fr', 'pt-BR')).toBe('pt-BR');
  });

  it('falls back to DEFAULT_LOCALE when both are missing or invalid', () => {
    expect(resolveLocale(undefined, undefined)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('fr', 'de')).toBe(DEFAULT_LOCALE);
  });
});
