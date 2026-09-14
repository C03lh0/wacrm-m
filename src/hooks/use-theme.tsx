"use client";

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  MODE_STORAGE_KEY,
  STORAGE_KEY,
  isMode,
  isThemeId,
  type Mode,
  type ThemeId,
} from "@/lib/themes";

/**
 * ThemeProvider — wraps the whole app, owns the two theming axes:
 *   • `theme` — the accent color (`data-theme` on <html>)
 *   • `mode`  — light / dark (`data-mode` on <html>)
 * The two are independent, so any accent renders in either mode.
 *
 * The boot script in `src/app/layout.tsx` has already applied both
 * `data-theme` and `data-mode` before React hydrates, so by the time
 * this Provider mounts the page is already painted correctly. Those two
 * attributes are the store: we read them through `useSyncExternalStore`
 * rather than mirroring them into React state, so there is no second
 * copy that can disagree with the DOM.
 *
 * That hook is also what makes this hydration-safe. The server renders
 * the defaults, the boot script may have put something else on <html>,
 * and hydration compares the two — reading the DOM during the first
 * client render would make every mode-dependent child (ModeToggle, the
 * settings panels) differ from the server HTML and blow up hydration.
 * `<html>` itself is `suppressHydrationWarning`, its children are not.
 * `getServerSnapshot` returns the defaults and React uses it for the
 * hydration render too, then swaps in the real values right after.
 * See `use-theme.test.tsx`.
 *
 * The page itself does not flash across that swap: the light/dark
 * surfaces are CSS keyed off `data-mode`, which the boot script already
 * set, and ModeToggle picks both its icon and its accessible name the
 * same way. Consumers that render `mode`/`theme` as React output — the
 * settings panels' selected-chip state — do briefly show the default
 * before the swap lands. That is the deliberate trade: a one-frame
 * wrong highlight on one screen, rather than a hydration error on
 * every screen.
 *
 * Persistence is localStorage only (device-scoped). A future
 * follow-up could mirror to `profiles.preferences` for cross-device
 * sync, but a per-device choice is also defensible — your phone may
 * deserve a different theme than your laptop.
 */

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (next: ThemeId) => void;
  mode: Mode;
  setMode: (next: Mode) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readAppliedTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  // Whatever the boot script applied is the truth. Fall back to
  // localStorage / default if for some reason the attribute is missing
  // (e.g. someone bypassed the boot script in a custom layout).
  const fromAttr = document.documentElement.dataset.theme;
  if (isThemeId(fromAttr)) return fromAttr;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
  }
  return DEFAULT_THEME;
}

function readAppliedMode(): Mode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const fromAttr = document.documentElement.dataset.mode;
  if (isMode(fromAttr)) return fromAttr;
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (isMode(stored)) return stored;
  } catch {
    // localStorage can throw in private-browsing / sandboxed contexts.
  }
  return DEFAULT_MODE;
}

/**
 * The `<html>` dataset IS the store — no React state mirrors it, so the
 * attribute the boot script wrote and what components render can never
 * drift apart. Subscribers are notified when this tab writes (`emit`)
 * or when another tab does (the `storage` listener below).
 */
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function onStorage(e: StorageEvent) {
  if (e.key === STORAGE_KEY && isThemeId(e.newValue)) {
    document.documentElement.dataset.theme = e.newValue;
    emit();
    return;
  }
  if (e.key === MODE_STORAGE_KEY && isMode(e.newValue)) {
    document.documentElement.dataset.mode = e.newValue;
    emit();
  }
}

function subscribe(listener: () => void) {
  // Sync from other tabs — change theme or mode in tab A, tab B catches
  // up without a refresh. One shared listener, however many subscribers.
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The third argument is the server snapshot, which React also uses for
  // the hydration render — that's what keeps children matching the
  // server HTML. See the note above.
  const theme = useSyncExternalStore(
    subscribe,
    readAppliedTheme,
    () => DEFAULT_THEME,
  );
  const mode = useSyncExternalStore(
    subscribe,
    readAppliedMode,
    () => DEFAULT_MODE,
  );

  const setTheme = useCallback((next: ThemeId) => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = next;
    }
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Same private-browsing edge case as above; the attribute still
      // changed, so the current tab works for the session.
    }
    emit();
  }, []);

  const setMode = useCallback((next: Mode) => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.mode = next;
    }
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Same private-browsing edge case as above.
    }
    emit();
  }, []);

  const toggleMode = useCallback(() => {
    setMode(mode === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, mode, setMode, toggleMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider — return
    // no-op setters so callers don't crash. The boot script still
    // applied the right CSS attributes, so visually the page is fine.
    return {
      theme: DEFAULT_THEME,
      setTheme: () => {},
      mode: DEFAULT_MODE,
      setMode: () => {},
      toggleMode: () => {},
    };
  }
  return ctx;
}
