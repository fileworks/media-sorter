/**
 * What the destination will look like, drawn rather than described.
 *
 * This used to be one line — `Sorted / 2025 / 07 — July / IMG_4382.jpg` — sitting
 * *above* half the rows that determine it, and it could not show the thing
 * people get wrong: the review folders are siblings of the date hierarchy, not
 * children of it.
 *
 * It is now a card of its own beside the Sort group rather than the last row
 * inside it. As the group's final child it read as the output of the row above
 * it — renaming — when every row in the group feeds it; a card with its own
 * heading says whose result it is, and at the wide breakpoint it sticks, so the
 * setting being changed and the tree it changes are visible at once.
 */

import { useId } from "react";
import { FiFile, FiFolder } from "react-icons/fi";

import { useI18n } from "@/i18n/I18nContext";
import { folderPreviewTree, type FolderPreviewNode, type SampleFile } from "@/lib/configSummary";
import { cn } from "@/lib/utils";
import type { Config } from "@/types/api";

function TreeNode({ node }: { node: FolderPreviewNode }) {
  const review = node.kind === "review";
  const file = node.kind === "file";
  return (
    <li>
      <span
        className={cn(
          "flex items-center gap-1.5 py-px",
          review ? "text-warning" : file ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {file ? (
          <FiFile className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <FiFolder className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <span className="break-all">
          {node.name}
          {!file && "/"}
        </span>
      </span>
      {node.children && node.children.length > 0 && (
        <ul className="ml-[0.6rem] border-l border-border pl-3">
          {node.children.map((child) => (
            <TreeNode key={child.name} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FolderTreePreview({
  config,
  samples,
  /** True when the filenames are invented rather than drawn from a real scan. */
  invented,
}: {
  config: Config;
  samples: readonly SampleFile[];
  invented: boolean;
}) {
  const { t, locale } = useI18n();
  const headingId = useId();
  const nodes = folderPreviewTree(config, t, locale, samples);
  const deduplicateOnly = config.run_mode === "deduplicate_only";

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-border bg-card p-4 xl:sticky xl:top-4"
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2
          id={headingId}
          className="text-3xs font-semibold uppercase tracking-[0.1em] text-foreground"
        >
          {t("config.folder.previewTitle")}
        </h2>
        {invented && !deduplicateOnly && (
          <span className="text-3xs text-faint">{t("config.folder.previewExample")}</span>
        )}
      </div>
      <p className="mb-2.5 text-xs text-faint">{t("config.folder.previewAttribution")}</p>
      <ul className="font-mono text-xs">
        <li>
          <span className="flex items-center gap-1.5 py-px font-semibold text-foreground">
            <FiFolder className="h-3 w-3 shrink-0" aria-hidden />
            <span className="break-all">{t("config.example.destination")}/</span>
          </span>
          <ul className="ml-[0.6rem] border-l border-border pl-3">
            {nodes.map((node) => (
              <TreeNode key={node.name} node={node} />
            ))}
          </ul>
        </li>
      </ul>
      <p className="mt-2 text-xs text-faint">
        {deduplicateOnly ? t("config.folder.previewStaysInPlace") : t("config.folder.fallbackNote")}
      </p>
    </section>
  );
}
