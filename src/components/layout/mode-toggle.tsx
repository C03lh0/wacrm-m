"use client";

import { Moon, Sun } from "lucide-react";

import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

import { useTranslations } from "next-intl";

/**
 * Light/dark mode toggle — a single icon button that flips the app
 * between the two modes. Sun shows in light mode (click → go dark),
 * moon shows in dark mode (click → go light); the label always names
 * the destination so screen-reader users hear what the click does.
 * One message key per destination rather than an interpolated mode
 * name — "light"/"dark" have to be translated too.
 *
 * Both icons are rendered and CSS keyed off `<html data-mode>` shows
 * one (see globals.css). That keeps the icon right from first paint —
 * the server always renders the default mode, so choosing here in React
 * would mismatch on hydration for anyone on the other mode.
 *
 * The accessible name is swapped by that same CSS rule, for the same
 * reason: picking it in React would have it name the wrong destination
 * until the post-hydration swap lands, contradicting the icon sitting
 * next to it. `display: none` keeps the hidden one out of the
 * accessibility tree, so exactly one name is exposed. There is
 * deliberately no `aria-label` — it would override this text.
 *
 * 40×40 hit target to match the header's other touch controls.
 */
export function ModeToggle({ className }: { className?: string }) {
  const t = useTranslations("ModeToggle");
  const { toggleMode } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleMode}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      <Moon data-mode-icon="dark" className="h-5 w-5" />
      <Sun data-mode-icon="light" className="h-5 w-5" />
      <span data-mode-icon="dark" className="sr-only">
        {t("switchToLight")}
      </span>
      <span data-mode-icon="light" className="sr-only">
        {t("switchToDark")}
      </span>
    </button>
  );
}
