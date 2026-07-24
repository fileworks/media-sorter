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

export type Locale = keyof typeof catalogs;
export type MessageParams = Record<string, string | number>;

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey | string, params?: MessageParams, fallback?: string) => string;
  formatNumber: (value: number) => string;
  formatDate: (value: Date | string, options?: Intl.DateTimeFormatOptions) => string;
}

const I18nContext = createContext<I18nValue | null>(null);
const STORAGE_KEY = "mediasort_language";

export function storedLocale(): Locale {
  try {
    return localStorage.getItem(STORAGE_KEY) === "de" ? "de" : "en";
  } catch {
    return "en";
  }
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
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage is optional; the persisted backend config remains authoritative.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params, fallback) => translate(locale, key, params, fallback),
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
