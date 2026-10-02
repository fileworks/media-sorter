/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { catalogs, type MessageKey } from "@/i18n/messages";
import { readStored, writeStored } from "@/lib/storage";

export type Locale = keyof typeof catalogs;
export type MessageParams = Record<string, string | number>;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey | string, params?: MessageParams, fallback?: string) => string;
  /** `t` for a counted thing: picks the singular form when there is one. */
  tCount: (key: MessageKey | string, count: number, params?: MessageParams) => string;
  formatNumber: (value: number) => string;
  formatDate: (value: Date | string, options?: Intl.DateTimeFormatOptions) => string;
}

const I18nContext = createContext<I18nValue | null>(null);
const STORAGE_KEY = "mediasort_language";

export function storedLocale(): Locale {
  return readStored(STORAGE_KEY) === "de" ? "de" : "en";
}

export function translate(
  locale: Locale,
  key: MessageKey | string,
  params: MessageParams = {},
  fallback?: string,
): string {
  const catalog = catalogs[locale] as Record<string, string>;
  const english = catalogs.en as Record<string, string>;
  const template = catalog[key] ?? english[key] ?? fallback ?? key;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * A counted message, in the form the count calls for.
 *
 * `key.one` when there is exactly one and the catalogue offers that form, `key`
 * otherwise. Both languages read as broken without it — "1 files", "1 Dateien"
 * — and the alternative, a ternary at each call site, is how three places got
 * it right and a dozen did not.
 */
export function plural(
  locale: Locale,
  key: MessageKey | string,
  count: number,
  params: MessageParams = {},
): string {
  const singular = `${key}.one`;
  const chosen = count === 1 && singular in catalogs.en ? singular : key;
  // An explicit `count` param wins: several call sites pass a locale-formatted
  // count for display while the raw number decides the form.
  return translate(locale, chosen, { count, ...params });
}

export function I18nProvider({
  children,
  initialLocale = storedLocale(),
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    // Storage is optional; the persisted backend config remains authoritative.
    writeStored(STORAGE_KEY, next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params, fallback) => translate(locale, key, params, fallback),
      tCount: (key, count, params) => plural(locale, key, count, params),
      formatNumber: (number) => new Intl.NumberFormat(locale).format(number),
      formatDate: (raw, options) =>
        new Intl.DateTimeFormat(locale, options).format(raw instanceof Date ? raw : new Date(raw)),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
