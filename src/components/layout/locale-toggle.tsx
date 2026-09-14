"use client";

import { useTranslations } from "next-intl";

import { useLocaleSwitch } from "@/hooks/use-locale-switch";
import { SUPPORTED_LOCALES } from "@/lib/i18n/locales";
import { cn } from "@/lib/utils";

/**
 * EN/PT language switcher — both locales are on screen side by side,
 * the active one highlighted, so the current language and the
 * alternative are readable at a glance. (A single flip-button showed
 * only one of the two, leaving you to guess whether the label meant
 * "you are here" or "click for this".)
 *
 * The segment for the active locale is inert: `switchLocale` ignores a
 * switch to the locale already in use.
 *
 * Rendered from SUPPORTED_LOCALES, so the switcher offers exactly the
 * locales that module says are offerable — `ko` is a valid app locale
 * but deliberately not one of them (see locales.ts). Running under it
 * simply leaves neither segment marked active, which is the truth.
 *
 * Sized to sit next to ModeToggle in the header and the auth pages:
 * same 40px outer height, same hover treatment. Each segment fills
 * that height so both are full-size touch targets, not 32px ones
 * floating inside a 40px frame.
 */
export function LocaleToggle({ className }: { className?: string }) {
  const t = useTranslations("Header");
  const { currentLocale, switchLocale } = useLocaleSwitch();

  return (
    <div
      role="group"
      aria-label={t("language")}
      className={cn(
        "inline-flex h-10 items-center gap-0.5 rounded-md border border-border p-0.5",
        className,
      )}
    >
      {SUPPORTED_LOCALES.map(({ code, label }) => {
        const isActive = code === currentLocale;
        return (
          <button
            key={code}
            type="button"
            onClick={() => switchLocale(code)}
            aria-pressed={isActive}
            // The active segment does nothing, so promising a switch
            // would be a lie — `aria-pressed` already says it's on.
            aria-label={
              isActive ? label : t("switchLanguage", { name: label })
            }
            title={label}
            className={cn(
              "h-full rounded-sm px-2 text-xs font-semibold transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {/* "pt-BR" → "PT": the region suffix is noise at this size. */}
            {code.slice(0, 2).toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
