import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_MODE, DEFAULT_THEME } from '@/lib/themes';

import { ThemeProvider, useTheme } from './use-theme';

/**
 * Hydration safety.
 *
 * The server always renders the `<html>` defaults, and the boot script in
 * `src/app/layout.tsx` rewrites `data-theme` / `data-mode` from localStorage
 * before React hydrates. So at hydration time the DOM already carries the
 * user's choice while the server HTML carries the defaults — if the provider
 * seeds its state from that DOM, every mode-dependent child (ModeToggle's
 * icon and label, the settings panels) renders differently than the server
 * did and React throws a hydration mismatch.
 *
 * `renderToStaticMarkup` runs render without effects, which is exactly the
 * hydration render. Stubbing `window` + `document` to a *non-default* choice
 * therefore reproduces the browser's first render: it must still come out as
 * the defaults.
 */

function Probe() {
  const { theme, mode } = useTheme();
  return <span data-probe={`${theme}/${mode}`} />;
}

function renderHydrationPass() {
  return renderToStaticMarkup(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  );
}

const globals = globalThis as Record<string, unknown>;

function stubBrowser(theme: string, mode: string) {
  globals.window = {};
  globals.document = { documentElement: { dataset: { theme, mode } } };
  globals.localStorage = {
    getItem: (key: string) =>
      key === 'wacrm.theme' ? theme : key === 'wacrm.mode' ? mode : null,
    setItem: () => {},
  };
}

afterEach(() => {
  delete globals.window;
  delete globals.document;
  delete globals.localStorage;
});

describe('ThemeProvider', () => {
  it('renders the server defaults on the server', () => {
    expect(renderHydrationPass()).toContain(
      `data-probe="${DEFAULT_THEME}/${DEFAULT_MODE}"`
    );
  });

  it('still renders the server defaults on the hydration pass, whatever the boot script put on <html>', () => {
    // A user whose stored choice differs from the defaults on both axes.
    stubBrowser('rose', 'light');

    expect(renderHydrationPass()).toContain(
      `data-probe="${DEFAULT_THEME}/${DEFAULT_MODE}"`
    );
  });
});
