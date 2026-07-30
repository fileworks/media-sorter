/**
 * Original versus candidate, side by side, for one generated sample.
 *
 * This is the only place a user sees what an optimizer would actually do to
 * their media. It shows the exact settings, the measurements, the sampling
 * scope, and the caveat that a good sample is not approval for the batch —
 * because a comparison that hides any of those is a sales pitch, not evidence.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytesShort, samplePresentation } from "@/lib/optimizationProjection";
import { getBasename } from "@/lib/pathUtils";
import { api } from "@/services/api";
import type { OptimizationContract, SampleEncode } from "@/services/api";

type ViewMode = "side-by-side" | "difference";

interface SampleComparisonModalProps {
  sample: SampleEncode;
  contract: OptimizationContract | null;
  /** Other comparable samples, for previous/next without leaving the modal. */
  samples?: SampleEncode[];
  onClose: () => void;
}

function Measurement({
  name,
  value,
  threshold,
}: {
  name: string;
  value: unknown;
  threshold: unknown;
}) {
  const measured = value !== undefined && value !== null;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-xs">
      <span className="text-muted-foreground">{name.replace(/_/g, " ")}</span>
      <span className={measured ? "tabular-nums text-foreground" : "text-warning"}>
        {measured ? String(value) : "not measured"}
        {threshold !== undefined && threshold !== null && (
          <span className="ml-2 text-muted-foreground">(needs {String(threshold)})</span>
        )}
      </span>
    </div>
  );
}

export function SampleComparisonModal({
  sample: initialSample,
  contract,
  samples = [],
  onClose,
}: SampleComparisonModalProps) {
  const { t } = useI18n();
  const [sample, setSample] = useState(initialSample);
  const [mode, setMode] = useState<ViewMode>("side-by-side");
  const [diffBroken, setDiffBroken] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

  useEffect(() => {
    setSample(initialSample);
    setDiffBroken(false);
  }, [initialSample]);

  const comparable = useMemo(
    () => samples.filter((item) => item.comparable && item.candidate_path !== null),
    [samples],
  );
  const index = comparable.findIndex((item) => item.source_path === sample.source_path);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < comparable.length - 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && hasPrev) setSample(comparable[index - 1]);
      if (event.key === "ArrowRight" && hasNext) setSample(comparable[index + 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, comparable, index, hasPrev, hasNext]);

  const presentation = samplePresentation(sample);
  const candidatePath = sample.candidate_path;

  // A modal that cannot show a candidate must not pretend to be a comparison.
  if (!presentation.canCompare || candidatePath === null) {
    return null;
  }

  const outcomeTone =
    presentation.outcome === "passed"
      ? "text-success"
      : presentation.outcome === "failed"
        ? "text-error"
        : "text-warning";

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("optimization.compare.title", undefined, "Original versus candidate")}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-5xl flex-col gap-4 overflow-auto rounded-xl border border-border bg-card p-5 outline-none"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {getBasename(sample.source_path)}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("optimization.compare.scope", undefined, "Evaluated")}: {presentation.scope}
              {contract && ` · ${contract.mode.replace(/_/g, " ")} · ${contract.output_codec}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1 text-sm"
          >
            {t("common.close", undefined, "Close")}
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setMode("side-by-side")}
            aria-pressed={mode === "side-by-side"}
            className={`rounded-lg border px-3 py-1 text-xs ${
              mode === "side-by-side" ? "border-primary text-primary" : "border-border"
            }`}
          >
            {t("optimization.compare.sideBySide", undefined, "Side by side")}
          </button>
          {!diffBroken && (
            <button
              type="button"
              onClick={() => setMode("difference")}
              aria-pressed={mode === "difference"}
              className={`rounded-lg border px-3 py-1 text-xs ${
                mode === "difference" ? "border-primary text-primary" : "border-border"
              }`}
            >
              {t("optimization.compare.difference", undefined, "Difference")}
            </button>
          )}
        </div>

        {mode === "side-by-side" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              { label: "Original", path: sample.source_path, bytes: sample.source_bytes },
              { label: "Candidate", path: candidatePath, bytes: sample.candidate_bytes },
            ].map((side) => (
              <figure key={side.label} className="space-y-2">
                <img
                  src={api.thumbnailUrl(side.path, 1200)}
                  alt={`${side.label} — ${getBasename(side.path)}`}
                  className="max-h-[46vh] w-full rounded-lg object-contain"
                  loading="lazy"
                />
                <figcaption className="text-xs text-muted-foreground">
                  {side.label} · {formatBytesShort(side.bytes)}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <img
            src={api.diffUrl(sample.source_path, candidatePath, 1200)}
            alt={t("optimization.compare.differenceAlt", undefined, "Difference heat map")}
            className="max-h-[50vh] w-full rounded-lg object-contain"
            onError={() => {
              setDiffBroken(true);
              setMode("side-by-side");
            }}
          />
        )}

        <section className="rounded-lg border border-border p-3">
          <h3 className={`text-sm font-medium ${outcomeTone}`}>
            {presentation.outcome === "passed"
              ? t("optimization.compare.passed", undefined, "This sample met its contract")
              : presentation.outcome === "failed"
                ? t(
                    "optimization.compare.failed",
                    undefined,
                    "This sample did not meet its contract",
                  )
                : t(
                    "optimization.compare.unproven",
                    undefined,
                    "This sample could not prove its contract",
                  )}
          </h3>
          <div className="mt-2 divide-y divide-border">
            {Object.keys(sample.thresholds).map((name) => (
              <Measurement
                key={name}
                name={name}
                value={sample.measurements[name]}
                threshold={sample.thresholds[name]}
              />
            ))}
          </div>
          {contract && (
            <p className="mt-3 text-xs text-muted-foreground">
              {contract.quality_setting} · {contract.metadata_policy}
            </p>
          )}
          {presentation.warnings.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-warning">
              {presentation.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{presentation.batchCaveat}</p>
        </section>

        {comparable.length > 1 && (
          <nav className="flex items-center justify-between">
            <button
              type="button"
              disabled={!hasPrev}
              onClick={() => hasPrev && setSample(comparable[index - 1])}
              className="rounded-lg border border-border px-3 py-1 text-sm disabled:opacity-40"
            >
              {t("common.previous", undefined, "Previous")}
            </button>
            <span className="text-xs text-muted-foreground">
              {index + 1} / {comparable.length}
            </span>
            <button
              type="button"
              disabled={!hasNext}
              onClick={() => hasNext && setSample(comparable[index + 1])}
              className="rounded-lg border border-border px-3 py-1 text-sm disabled:opacity-40"
            >
              {t("common.next", undefined, "Next")}
            </button>
          </nav>
        )}
      </div>
    </div>,
    document.body,
  );
}
