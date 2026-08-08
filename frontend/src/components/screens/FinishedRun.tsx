/** The run is over: the result, its report, and the next lifecycle action. */

import { ReportPanel } from "@/components/ReportPanel";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { formatDuration } from "@/lib/formatters";
import type { OperationReport } from "@/types/api";

export function FinishedRun({
  report,
  onStartNewRun,
}: {
  report: OperationReport;
  onStartNewRun: () => void;
}) {
  const { t, locale } = useI18n();
  const messageKey =
    report.summary.sorted === 1
      ? report.duration_seconds
        ? "report.organizedIn.one"
        : "report.organized.one"
      : report.duration_seconds
        ? "report.organizedIn"
        : "report.organized";

  return (
    <div className="space-y-4">
      <div className="animate-fade-in rounded-2xl border border-success/40 bg-tint-success px-5 py-4">
        <p className="text-sm font-bold text-foreground">
          {t(messageKey, {
            count: report.summary.sorted.toLocaleString(locale),
            duration: formatDuration(report.duration_seconds, { style: "long", locale }),
          })}
        </p>
      </div>
      <ReportPanel report={report} />
      <div className="flex justify-center">
        <Button onClick={onStartNewRun}>{t("report.startNewRun")}</Button>
      </div>
    </div>
  );
}
