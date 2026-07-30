import { useEffect, useState } from "react";
import { ExecutePreflight } from "@/components/OperationCenter";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { api, type BurstDecision, type BurstGroup, type PreviewItem } from "@/services/api";

interface BurstReviewPanelProps {
  root: string;
  items: PreviewItem[];
  enabled: boolean;
}

export function BurstReviewPanel({ root, items, enabled }: BurstReviewPanelProps) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<BurstGroup[]>([]);
  const [kept, setKept] = useState<Record<string, string[]>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState(0);
  const [pending, setPending] = useState<BurstDecision | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [completed, setCompleted] = useState<number | null>(null);
  const [detected, setDetected] = useState(false);

  const detect = async () => {
    setRunning(true);
    setError(null);
    try {
      const detected = await api.detectBursts(
        root,
        items.map((item) => item.source),
      );
      setGroups(detected);
      setDetected(true);
      setActiveGroup(0);
      setKept(
        Object.fromEntries(
          detected.map((group) => [group.group_id, [group.proposed_representative_id]]),
        ),
      );
    } catch (cause) {
      setError(extractErrorMessage(cause, t("bursts.failed")));
    } finally {
      setRunning(false);
    }
  };

  const toggle = (group: BurstGroup, frameId: string) => {
    setKept((current) => {
      const values = current[group.group_id] ?? [];
      return {
        ...current,
        [group.group_id]: values.includes(frameId)
          ? values.filter((item) => item !== frameId)
          : [...values, frameId],
      };
    });
  };

  const decide = async (group: BurstGroup, dismissed = false) => {
    setError(null);
    try {
      const response = await api.decideBurst(group, kept[group.group_id] ?? [], dismissed);
      setGroups((current) =>
        current.map((item) => (item.group_id === group.group_id ? response.group : item)),
      );
      setPending(response.impact.quarantine_count > 0 ? response : null);
      setAcknowledged(false);
    } catch (cause) {
      setError(extractErrorMessage(cause, t("bursts.decisionFailed")));
    }
  };

  const execute = async () => {
    if (!pending) return;
    setError(null);
    try {
      const report = await api.executeBurstPlan(pending.plan.plan_id);
      setCompleted(report.quarantined.length);
      setPending(null);
      setAcknowledged(false);
    } catch (cause) {
      setError(extractErrorMessage(cause, t("bursts.executeFailed")));
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.matches("input, textarea, select, [role='textbox']")
      ) {
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || groups.length === 0) return;
      const group = groups[Math.min(activeGroup, groups.length - 1)];
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        setActiveGroup((index) => (index + 1) % groups.length);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        setActiveGroup((index) => (index - 1 + groups.length) % groups.length);
      } else if (/^[1-9]$/.test(event.key) && !group.reviewed) {
        const frame = group.frames[Number(event.key) - 1];
        if (frame) {
          event.preventDefault();
          toggle(group, frame.frame_id);
        }
      } else if (event.key === "Enter" && !group.reviewed) {
        if ((kept[group.group_id] ?? []).length > 0) {
          event.preventDefault();
          void decide(group);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!enabled) {
    return (
      <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        {t("bursts.disabled")}
      </p>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="burst-review-title">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="burst-review-title" className="text-base font-semibold text-foreground">
            {t("bursts.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("bursts.reviewFirst")}</p>
        </div>
        <Button disabled={running} onClick={() => void detect()}>
          {running ? t("bursts.detecting") : t("bursts.detect")}
        </Button>
      </header>
      {error && <StateView variant="error" compact title={t("bursts.failed")} detail={error} />}
      {!running && groups.length === 0 && !error && (
        <StateView
          variant="empty"
          compact
          title={detected ? t("bursts.empty") : t("bursts.notRun")}
        />
      )}
      {groups.map((group, groupIndex) => (
        <article
          key={group.group_id}
          className="space-y-3 rounded-xl border border-border bg-card p-3"
          aria-label={t("bursts.group", { count: group.frames.length })}
          aria-current={groupIndex === activeGroup ? "true" : undefined}
          tabIndex={0}
          onFocus={() => setActiveGroup(groupIndex)}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.frames.map((frame) => {
              const selected = (kept[group.group_id] ?? []).includes(frame.frame_id);
              const proposed = frame.frame_id === group.proposed_representative_id;
              return (
                <label
                  key={frame.frame_id}
                  className={`cursor-pointer rounded-lg border p-2 ${
                    selected ? "border-primary" : "border-border"
                  }`}
                >
                  <Thumbnail
                    path={frame.primary_path}
                    maxPx={640}
                    className="h-40 w-full rounded"
                  />
                  <span className="mt-2 flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={group.reviewed}
                      onChange={() => toggle(group, frame.frame_id)}
                    />
                    {t("bursts.keep")}
                    {proposed && <strong>{t("bursts.proposed")}</strong>}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {new Date(frame.captured_at).toLocaleTimeString()} ·{" "}
                    {frame.sharpness === null
                      ? t("bursts.sharpnessUnknown")
                      : t("bursts.sharpness", { score: frame.sharpness.toFixed(1) })}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {frame.member_paths.length} {t("bursts.unitMembers")}
                  </span>
                  <details className="mt-2 rounded border border-border p-2 text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer font-medium text-foreground">
                      {t("preview.explanation.title")}
                    </summary>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                      <dt>{t("bursts.evidence.time")}</dt>
                      <dd>{new Date(frame.captured_at).toLocaleString()}</dd>
                      <dt>{t("bursts.evidence.camera")}</dt>
                      <dd>{frame.camera_identity}</dd>
                      <dt>{t("bursts.evidence.distance")}</dt>
                      <dd>
                        {frame.perceptual_distance_from_previous ?? t("bursts.evidence.first")}
                      </dd>
                      <dt>{t("bursts.evidence.ranking")}</dt>
                      <dd>
                        {frame.sharpness === null
                          ? t("bursts.sharpnessUnknown")
                          : t("bursts.sharpness", { score: frame.sharpness.toFixed(1) })}
                      </dd>
                    </dl>
                    <p className="mt-2">{t("bursts.evidence.scope")}</p>
                  </details>
                </label>
              );
            })}
          </div>
          {group.reviewed ? (
            <p role="status" className="text-xs text-success">
              {group.dismissed ? t("bursts.dismissed") : t("bursts.reviewed")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={(kept[group.group_id] ?? []).length === 0}
                onClick={() => void decide(group)}
              >
                {t("bursts.confirm")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void decide(group, true)}>
                {t("bursts.keepAll")}
              </Button>
            </div>
          )}
          {pending?.group.group_id === group.group_id && (
            <ExecutePreflight
              input={{
                actionableGroups: 1,
                quarantineCount: pending.impact.quarantine_count,
                quarantineBytes: pending.impact.quarantine_bytes,
                copyCount: 0,
                moveCount: 0,
                skipCount: pending.group.kept_frame_ids.length,
                referenceCount: 0,
                sourceMutations: pending.impact.source_mutations,
                acknowledgedSourceMutations: acknowledged,
                staleGroups: 0,
                unresolvedGroups: 0,
                freeBytes: null,
                requiredBytes: pending.impact.quarantine_bytes,
                quarantineWritable: true,
                conversionWithoutOriginals: 0,
                companionsLeftInPlace: 0,
                embeddedTagCount: 0,
              }}
              onAcknowledge={setAcknowledged}
              onExecute={() => void execute()}
            />
          )}
        </article>
      ))}
      {completed !== null && (
        <p role="status" className="rounded bg-success/10 p-2 text-sm text-success">
          {t("bursts.executed", { count: completed })}
        </p>
      )}
    </section>
  );
}
