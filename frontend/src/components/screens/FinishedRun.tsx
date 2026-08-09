/** The run is over: the result, its report, and the next lifecycle action. */

import { ReportPanel } from "@/components/ReportPanel";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import type { OperationReport } from "@/types/api";

export function FinishedRun({
  report,
  onStartNewRun,
  onOpenHistory,
}: {
  report: OperationReport;
  onStartNewRun: () => void;
  onOpenHistory: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      <ReportPanel report={report} />
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="outline" onClick={onOpenHistory}>
          {t("execute.openHistory")}
        </Button>
        <Button onClick={onStartNewRun}>{t("report.startNewRun")}</Button>
      </div>
    </div>
  );
}
