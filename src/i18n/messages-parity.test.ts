import { describe, it, expect } from 'vitest';

import en from '../../messages/en.json';
import ptBR from '../../messages/pt-BR.json';
import ko from '../../messages/ko.json';

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
