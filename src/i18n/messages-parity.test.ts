import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import en from '../../messages/en.json';
import ptBR from '../../messages/pt-BR.json';
import ko from '../../messages/ko.json';
import { SUPPORTED_LOCALES } from '@/lib/i18n/locales';

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, nested]) => flattenKeys(nested, prefix ? `${prefix}.${key}` : key)
  );
}

const enKeys = new Set(flattenKeys(en));

function diff(otherKeys: Set<string>) {
  return {
    missing: [...enKeys].filter((key) => !otherKeys.has(key)),
    extra: [...otherKeys].filter((key) => !enKeys.has(key)),
  };
}

describe('translation key parity against messages/en.json', () => {
  it('pt-BR.json has exactly the same keys', () => {
    expect(diff(new Set(flattenKeys(ptBR)))).toEqual({
      missing: [],
      extra: [],
    });
  });

  it('ko.json has exactly the same keys', () => {
    expect(diff(new Set(flattenKeys(ko)))).toEqual({
      missing: [],
      extra: [],
    });
  });
});

describe('every SUPPORTED_LOCALES entry ships a dictionary file', () => {
  for (const { code } of SUPPORTED_LOCALES) {
    it(`messages/${code}.json exists on disk`, () => {
      const path = join(process.cwd(), 'messages', `${code}.json`);
      expect(existsSync(path)).toBe(true);
    });
  }
});
