/**
 * The footer rail for whichever stage is current.
 *
 * One sentence, one way back, one way on — the same three slots on every stage,
 * so the flow can be walked without hunting for where the button moved to. It
 * lives here rather than inside the page because it is presentation over the
 * navigation model and a handful of figures, and the page it came from had
 * grown past the size at which anybody reads all of it.
 *
 * Execute has no rail: it carries its own controls, because "start" and "cancel"
 * are not the same shape as "continue".
 */

import { ActionBar } from "@/components/shell/ActionBar";
import type { StageNav } from "@/components/StageShell";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes, formatDuration } from "@/lib/formatters";
import type { Stage } from "@/lib/stageModel";
import type { AnalysisResult } from "@/types/api";

interface StageFooterProps {
  stage: Stage;
  nav: StageNav;
  /** The scan, for Configure's estimate. Absent until one has run. */
  analysis: AnalysisResult | null;
  busy: boolean;
  /** Configure's primary is the only one gated on more than the stage model. */
  previewReady: { ok: boolean; reason: string | null };
  onPreview: () => void;
}

export function StageFooter({
  stage,
  nav,
  analysis,
  busy,
  previewReady,
  onPreview,
}: StageFooterProps) {
  const { t, locale } = useI18n();

  if (stage === "execute") return null;

  if (stage === "sources") {
    return (
      <ActionBar
        message={t("footer.sources")}
        primary={{
          label: t("footer.toRecipe"),
          onClick: () => nav.go("recipe"),
          disabled: !nav.canEnter("recipe"),
          disabledReason: nav.reasonFor("recipe"),
        }}
      />
    );
  }

  if (stage === "recipe") {
    return (
      <ActionBar
        message={t("footer.recipe")}
        back={{ label: t("common.back"), onClick: () => nav.go("sources") }}
        primary={{
          label: t("footer.toConfigure"),
          onClick: () => nav.go("configure"),
          disabled: !nav.canEnter("configure"),
          disabledReason: nav.reasonFor("configure"),
        }}
      />
    );
  }

  if (stage === "configure") {
    const estimate = analysis
      ? t("footer.estimate", {
          files: analysis.total_files.toLocaleString(locale),
          duration: formatDuration(analysis.estimated_duration_seconds, {
            style: "long",
            locale,
          }),
          size: formatBytes(analysis.total_size_bytes, { locale }),
        })
      : t("footer.estimateUnknown");
    return (
      <ActionBar
        tone="estimate"
        message={estimate}
        back={{ label: t("common.back"), onClick: () => nav.go("recipe") }}
        primary={{
          label: t("footer.preview"),
          busy,
          onClick: onPreview,
          disabled: !previewReady.ok,
          // Every reason this button can be disabled names itself. A settings
          // problem is the one that is fixable right here, on this screen, so it
          // must not be reported as a folder problem.
          disabledReason: previewReady.reason,
        }}
      />
    );
  }

  return (
    <ActionBar
      message={t("footer.review")}
      back={{ label: t("common.back"), onClick: () => nav.go("configure") }}
      primary={{
        label: t("footer.toExecute"),
        onClick: () => nav.go("execute"),
        disabled: !nav.canEnter("execute"),
        disabledReason: nav.reasonFor("execute"),
      }}
    />
  );
}
