/**
 * The live log, on the page rather than in a drawer.
 *
 * During a long run this is the difference between "working" and "hung", so it
 * belongs where the user already is. Auto-scroll follows the tail until they
 * scroll up — at which point it stops and says so, because yanking somebody
 * back to the bottom while they are reading is the fastest way to make a log
 * useless.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiChevronDown, FiChevronUp } from "react-icons/fi";

import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import type { LogEntry } from "@/types/api";

const LEVEL_CLASS: Record<string, string> = {
  debug: "text-faint",
  info: "text-success",
  warning: "text-warning",
  error: "text-error",
  critical: "text-error",
};

const LEVEL_TAG: Record<string, string> = {
  debug: "dbg",
  info: "ok",
  warning: "warn",
  error: "err",
  critical: "err",
};

export function RunLog({ entries, running }: { entries: LogEntry[]; running: boolean }) {
  const { t, locale } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only re-pin to the tail when the user has not scrolled away.
  useLayoutEffect(() => {
    if (!following || collapsed) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries, following, collapsed]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      setFollowing(atBottom);
    };
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, [collapsed]);

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
        <h2 className="text-xs font-bold text-foreground">{t("execute.log")}</h2>
        <span className="text-xs text-faint">{t("execute.logHelp")}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setFollowing((value) => !value)}
          aria-pressed={following}
          className={cn(
            "rounded-full px-2.5 py-1 text-3xs font-semibold transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            following ? "bg-muted text-muted-foreground" : "text-faint hover:text-foreground",
          )}
        >
          {t(following ? "execute.autoScrollOn" : "execute.autoScrollOff")}
        </button>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-3xs text-faint transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(collapsed ? "execute.expand" : "execute.collapse")}
          {collapsed ? (
            <FiChevronDown className="h-3 w-3" aria-hidden />
          ) : (
            <FiChevronUp className="h-3 w-3" aria-hidden />
          )}
        </button>
      </header>

      {!collapsed && (
        <div
          ref={scrollRef}
          role="log"
          aria-live={running ? "polite" : "off"}
          aria-label={t("execute.log")}
          className="max-h-64 overflow-y-auto bg-background px-4 py-3 font-mono text-xs leading-[1.9]"
        >
          {entries.length === 0 ? (
            <p className="text-faint">{t("execute.logEmpty")}</p>
          ) : (
            entries.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className="flex gap-3">
                <span className="shrink-0 text-faint">
                  {new Date(entry.timestamp).toLocaleTimeString(locale, { hour12: false })}
                </span>
                <span
                  className={cn("w-8 shrink-0", LEVEL_CLASS[entry.level] ?? "text-muted-foreground")}
                >
                  {LEVEL_TAG[entry.level] ?? entry.level}
                </span>
                <span className="min-w-0 break-all text-muted-foreground">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
