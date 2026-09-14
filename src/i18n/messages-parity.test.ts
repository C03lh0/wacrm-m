import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SUPPORTED_LOCALES } from '@/lib/i18n/locales';

// Key/placeholder parity between the catalogues lives in
// messages.test.ts, which is upstream's and covers every translated
// locale. What's fork-specific — and what upstream has no equivalent
// of — is the runtime switcher: an entry in SUPPORTED_LOCALES with no
// dictionary on disk renders the whole app as raw keypaths for anyone
// who picks it.
describe('every SUPPORTED_LOCALES entry ships a dictionary file', () => {
  for (const { code } of SUPPORTED_LOCALES) {
    it(`messages/${code}.json exists on disk`, () => {
      const path = join(process.cwd(), 'messages', `${code}.json`);
      expect(existsSync(path)).toBe(true);
    });
  }
});
