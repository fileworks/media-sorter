/**
 * What the junk filters would set aside, and why each one was caught.
 *
 * Grouped by the rule that caught it rather than listed flat, because the
 * useful judgement is about the rule — "the under-50 KB rule caught 214 files"
 * is something a person can agree or disagree with; a list of 312 filenames is
 * not. Each group links to the filter that produced it.
 */

import { useMemo, useState } from "react";

import { MediaPreviewModal } from "@/components/MediaPreviewModal";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import { getBasename } from "@/lib/pathUtils";
import type { PreviewItem } from "@/types/api";

interface JunkTabProps {
  items: PreviewItem[];
  onOpenSetting: (anchorId: string) => void;
}

const PREVIEW_LIMIT = 12;

export function JunkTab({ items, onOpenSetting }: JunkTabProps) {
  const { t, locale } = useI18n();
  const [preview, setPreview] = useState<PreviewItem | null>(null);

  const junk = useMemo(() => items.filter((item) => item.status === "junk"), [items]);

  // The backend states a reason per file; anything without one is grouped under
  // a single honest "other" rather than being invented a category.
  const byReason = useMemo(() => {
    const groups = new Map<string, PreviewItem[]>();
    for (const item of junk) {
      const reason = item.quarantine_reason ?? "other";
      const existing = groups.get(reason);
      if (existing) existing.push(item);
      else groups.set(reason, [item]);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [junk]);

  if (junk.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-5 py-10 text-center">
        <p className="text-xs font-semibold text-foreground">{t("review.junk.none")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("review.junk.noneHelp")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-faint">{t("review.junk.intro")}</p>

      {byReason.map(([reason, group]) => (
        <section key={reason} className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            <h3 className="text-xs font-bold text-foreground">
              {t(`review.junk.reason.${reason}`, undefined, reason)}
            </h3>
            <span className="rounded-full bg-muted px-2 py-0.5 text-3xs font-semibold text-muted-foreground">
              {t("review.junk.count", { count: group.length.toLocaleString(locale) })}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => onOpenSetting("setting-junk")}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("review.junk.editFilter")}
            </button>
          </div>

          <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-6">
            {group.slice(0, PREVIEW_LIMIT).map((item) => (
              <li
                key={item.source}
                // Only the picture recedes: dimming the tile took its caption
                // below 4.5:1, and "this is junk" is already said by the tab.
                className="overflow-hidden rounded-lg border border-border transition-colors hover:border-faint [&_img]:opacity-75 [&_img]:hover:opacity-100"
              >
                <Thumbnail
                  path={item.source}
                  className="h-20 w-full"
                  onOpen={() => setPreview(item)}
                  openLabel={t("preview.openFile", { name: getBasename(item.source) })}
                />
                <div className="px-2 py-1.5">
                  <p className="truncate font-mono text-3xs text-foreground" title={item.source}>
                    {getBasename(item.source)}
                  </p>
                  <p className="text-3xs text-faint">
                    {formatBytes(item.file_size ?? 0, { locale })}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          {group.length > PREVIEW_LIMIT && (
            <p className="mt-2.5 text-xs text-faint">
              {t("review.junk.more", {
                count: (group.length - PREVIEW_LIMIT).toLocaleString(locale),
              })}
            </p>
          )}
        </section>
      ))}

      {preview && (
        <MediaPreviewModal item={preview} items={junk} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
