import { useState } from "react";
import {
  FiAlertCircle,
  FiCheck,
  FiDownloadCloud,
  FiExternalLink,
  FiHardDrive,
  FiLoader,
  FiRefreshCw,
  FiTrash2,
  FiX,
} from "react-icons/fi";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/progress";
import { useAiModels } from "@/hooks/useAiModels";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import { extractErrorMessage } from "@/lib/errorUtils";
import { cn } from "@/lib/utils";

function sourceHost(source: string): string {
  try {
    return new URL(source).host;
  } catch {
    return source;
  }
}

export function AiModelManager() {
  const { t, locale } = useI18n();
  const { inventory, isLoading, inventoryError, task, install, cancel, remove } = useAiModels();
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const pack = inventory?.packs.find(
    (candidate) => candidate.pack_id === inventory.required_pack_id,
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        <FiLoader className="h-4 w-4 animate-spin" />
        {t("config.ai.modelChecking")}
      </div>
    );
  }

  if (inventoryError || !inventory) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
        <FiAlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        {t("config.ai.modelStatusUnavailable")}
      </div>
    );
  }

  if (!inventory.required_pack_id || !pack) return null;

  const status = task?.status;
  const downloading = pack.state === "downloading" || status === "pending" || status === "running";
  const failed = pack.state === "error" || status === "failed" || status === "cancelled";
  const done = task?.progress.bytes_done ?? 0;
  const total = task?.progress.bytes_total || pack.total_size;
  const percentage = total > 0 ? Math.min(100, (done / total) * 100) : undefined;
  const actionError = install.error
    ? extractErrorMessage(install.error, t("config.ai.modelActionFailed")).message
    : remove.error
      ? extractErrorMessage(remove.error, t("config.ai.modelActionFailed")).message
      : null;

  return (
    <section
      className={cn(
        "rounded-xl border p-3",
        pack.state === "ready"
          ? "border-success/30 bg-success/5"
          : failed
            ? "border-destructive/30 bg-destructive/5"
            : "border-border bg-card",
      )}
      aria-label={t("config.ai.modelFiles")}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            pack.state === "ready"
              ? "bg-success/15 text-success"
              : failed
                ? "bg-destructive/15 text-destructive"
                : "bg-primary/10 text-primary",
          )}
        >
          {pack.state === "ready" ? (
            <FiCheck className="h-4 w-4" />
          ) : failed ? (
            <FiAlertCircle className="h-4 w-4" />
          ) : downloading ? (
            <FiLoader className="h-4 w-4 animate-spin" />
          ) : (
            <FiHardDrive className="h-4 w-4" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold text-foreground">{pack.display_name}</h4>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatBytes(pack.total_size, { locale, decimals: 0, nullPlaceholder: "0 B" })}
                {" · "}
                <a
                  href={pack.license_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
                >
                  {pack.license} <FiExternalLink className="h-3 w-3" />
                </a>
                {" · "}
                {sourceHost(pack.source)}
              </p>
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-1 text-2xs font-medium",
                pack.state === "ready"
                  ? "bg-success/15 text-success"
                  : failed
                    ? "bg-destructive/15 text-destructive"
                    : downloading
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground",
              )}
            >
              {t(
                pack.state === "ready"
                  ? "config.ai.modelReady"
                  : failed
                    ? "config.ai.modelFailed"
                    : downloading
                      ? "config.ai.modelDownloading"
                      : "config.ai.modelNotInstalled",
              )}
            </span>
          </div>

          {downloading && (
            <div className="mt-3 space-y-1.5">
              <ProgressBar value={percentage} label={t("config.ai.modelDownloading")} />
              <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {t(
                    task?.progress.phase === "verifying_model"
                      ? "config.ai.modelVerifying"
                      : task?.progress.phase === "publishing_model"
                        ? "config.ai.modelPublishing"
                        : "config.ai.modelProgress",
                    {
                      done: formatBytes(done, {
                        locale,
                        decimals: 0,
                        nullPlaceholder: "0 B",
                      }),
                      total: formatBytes(total, {
                        locale,
                        decimals: 0,
                        nullPlaceholder: "0 B",
                      }),
                    },
                  )}
                </span>
                <span>{Math.round(percentage ?? 0)}%</span>
              </div>
            </div>
          )}

          {(pack.error || task?.failure?.message || actionError) && (
            <p className="mt-2 text-xs text-destructive">
              {pack.error ?? task?.failure?.message ?? actionError}
            </p>
          )}

          <p className="mt-2 text-xs text-muted-foreground">
            {pack.state === "ready"
              ? t("config.ai.modelOffline")
              : t("config.ai.modelVerifiedDownload")}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {!downloading && pack.state !== "ready" && (
              <Button
                size="sm"
                onClick={() => install.mutate(pack.pack_id)}
                disabled={install.isPending}
              >
                {failed ? (
                  <FiRefreshCw className="h-3.5 w-3.5" />
                ) : (
                  <FiDownloadCloud className="h-4 w-4" />
                )}
                {failed ? t("config.ai.modelRetry") : t("config.ai.modelInstall")}
              </Button>
            )}
            {downloading && task && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => cancel.mutate(task.task_id)}
                disabled={cancel.isPending}
              >
                <FiX className="h-4 w-4" />
                {t("common.cancel")}
              </Button>
            )}
            {pack.state === "ready" &&
              (confirmingRemoval ? (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => remove.mutate(pack.pack_id)}
                    disabled={remove.isPending}
                  >
                    <FiTrash2 className="h-3.5 w-3.5" />
                    {t("config.ai.modelConfirmRemove")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingRemoval(false)}>
                    {t("common.cancel")}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirmingRemoval(true)}>
                  <FiTrash2 className="h-3.5 w-3.5" />
                  {t("config.ai.modelRemove")}
                </Button>
              ))}
          </div>
        </div>
      </div>
    </section>
  );
}
