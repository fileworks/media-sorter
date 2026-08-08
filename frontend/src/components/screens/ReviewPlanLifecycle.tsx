import type { ReactNode } from "react";

import { PreviewProgressCard } from "@/components/PreviewProgressCard";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import type { ExtractedError } from "@/lib/errorUtils";
import type { TaskProgress } from "@/types/api";

import { ScreenHeader } from "./ScreenHeader";

interface OperationState {
  loading: boolean;
  error: ExtractedError | null;
  cancelled: boolean;
  elapsed: number;
  progress: TaskProgress | null;
}

interface ReviewPlanLifecycleProps {
  analysis: OperationState;
  preview: OperationState;
  ready: boolean;
  onCancel: () => void;
  onRetry: () => void;
  children: ReactNode;
}

/** Own every state between requesting a plan and reviewing its finished result. */
export function ReviewPlanLifecycle({
  analysis,
  preview,
  ready,
  onCancel,
  onRetry,
  children,
}: ReviewPlanLifecycleProps) {
  const { t } = useI18n();

  if (analysis.loading || preview.loading) {
    const operation = analysis.loading ? analysis : preview;
    return (
      <PreviewProgressCard
        operation={analysis.loading ? "analysis" : "preview"}
        progress={operation.progress}
        elapsed={operation.elapsed}
        onCancel={onCancel}
      />
    );
  }

  const failure = analysis.error ?? preview.error;
  const cancelled = analysis.cancelled || preview.cancelled;
  if (!failure && !cancelled && ready) return children;

  return (
    <div>
      <ScreenHeader title={t("stage.review.label")} subtitle={t("stage.review.planHelp")} />
      {failure ? (
        <StateView
          variant="error"
          layout="page"
          title={analysis.error ? t("analysis.failed") : t("preview.failed")}
          detail={failure.message}
          code={failure.code}
          onRetry={onRetry}
        />
      ) : (
        <StateView
          variant="blocked"
          layout="page"
          title={cancelled ? t("stage.review.cancelled") : t("stage.review.planNeeded")}
          detail={cancelled ? t("stage.review.cancelledHelp") : t("stage.gate.plan")}
          action={
            <Button size="sm" onClick={onRetry}>
              {t("preview.action")}
            </Button>
          }
        />
      )}
    </div>
  );
}
