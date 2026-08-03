/**
 * What the destination will look like, drawn rather than described.
 *
 * This used to be one line — `Sorted / 2025 / 07 — July / IMG_4382.jpg` — sitting
 * *above* half the rows that determine it, and it could not show the thing
 * people get wrong: the review folders are siblings of the date hierarchy, not
 * children of it. It now sits at the foot of the group, below every row that
 * feeds it, and updates as any of them changes.
 */

import { FiFile, FiFolder } from "react-icons/fi";

import { SettingPreview } from "@/components/ui/setting-row";
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
  const nodes = folderPreviewTree(config, t, locale, samples);
  const deduplicateOnly = config.run_mode === "deduplicate_only";

  return (
    <SettingPreview last>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
        <span className="text-3xs font-semibold uppercase tracking-[0.1em] text-faint">
          {t("config.folder.previewTitle")}
        </span>
        {invented && !deduplicateOnly && (
          <span className="text-3xs text-faint">{t("config.folder.previewExample")}</span>
        )}
      </div>
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
      <p className="mt-1.5 text-xs text-faint">
        {deduplicateOnly ? t("config.folder.previewStaysInPlace") : t("config.folder.fallbackNote")}
      </p>
    </SettingPreview>
  );
}
