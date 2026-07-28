'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';

import type { Locale } from '@/lib/i18n/locales';

interface UseLocaleSwitch {
  currentLocale: Locale;
  switchLocale: (next: Locale) => void;
  isPending: boolean;
}

/**
 * Switches the app's language: POSTs the choice to /api/locale (which
 * sets the NEXT_LOCALE cookie), then refreshes Server Components via
 * router.refresh() so server-rendered text picks up the new locale
 * without a full page reload.
 */
export function useLocaleSwitch(): UseLocaleSwitch {
  const router = useRouter();
  const currentLocale = useLocale() as Locale;
  const [isPending, startTransition] = useTransition();

  const switchLocale = (next: Locale) => {
    if (next === currentLocale) return;
    fetch('/api/locale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: next }),
    }).then(() => {
      startTransition(() => {
        router.refresh();
      });
    });
  };

  return { currentLocale, switchLocale, isPending };
}
