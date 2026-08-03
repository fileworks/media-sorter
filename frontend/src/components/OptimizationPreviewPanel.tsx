/**
 * What optimization would do, before it is allowed to do anything.
 *
 * Every number on this panel carries its confidence, every estimate says it is
 * one, and a projected size *increase* is presented as a recommendation to skip
 * rather than as a smaller saving. Optimization is never described here with
 * the vocabulary used for moving files.
 */

import { useMemo, useState } from "react";

import { SampleComparisonModal } from "@/components/SampleComparisonModal";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytesShort } from "@/lib/formatters";
import {
  comparableSamples,
  confidenceTone,
  isEstimate,
  modeDisclosure,
  projectedSize,
  recommendationView,
  savingSummary,
  spaceRequirement,
} from "@/lib/optimizationProjection";
import { getBasename } from "@/lib/pathUtils";
import type {
  ItemProjection,
  OptimizationContract,
  OptimizationProjection,
  SampleEncode,
} from "@/services/api";

interface OptimizationPreviewPanelProps {
  projection: OptimizationProjection;
  contract: OptimizationContract | null;
  /** Overrides the user has explicitly granted for skip-recommended items. */
  overrides?: Set<string>;
  onToggleOverride?: (path: string) => void;
}

const TONE_CLASS: Record<string, string> = {
  measured: "text-success",
  estimated: "text-warning",
  unknown: "text-muted-foreground",
};

function ConfidenceBadge({ item }: { item: ItemProjection }) {
  const tone = confidenceTone(item.confidence);
  return (
    <span className={`text-2xs uppercase tracking-wide ${TONE_CLASS[tone]}`} title={item.reason}>
      {isEstimate(item) ? `${item.confidence} estimate` : "measured"}
    </span>
  );
}

function ItemRow({
  item,
  overridden,
  onToggleOverride,
}: {
  item: ItemProjection;
  overridden: boolean;
  onToggleOverride?: (path: string) => void;
}) {
  const size = projectedSize(item);
  const recommendation = recommendationView(item);

  return (
    <tr className="border-t border-border align-top">
      <td className="py-2 pr-3">
        <div className="text-sm text-foreground">{getBasename(item.path)}</div>
        <div className="text-xs text-muted-foreground">{item.reason}</div>
      </td>
      <td className="py-2 pr-3 text-right text-sm tabular-nums text-foreground">
        {formatBytesShort(item.current_bytes)}
      </td>
      <td className="py-2 pr-3 text-right text-sm tabular-nums">
        {size.label ?? <span className="text-muted-foreground">—</span>}
        <div>
          <ConfidenceBadge item={item} />
        </div>
      </td>
      <td className="py-2 pr-3 text-xs">
        <div
          className={
            recommendation.tone === "recommended"
              ? "text-success"
              : recommendation.tone === "skip"
                ? "text-warning"
                : "text-error"
          }
        >
          {recommendation.headline}
        </div>
        {recommendation.requiresOverride && onToggleOverride && (
          <label className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground">
            <input
              type="checkbox"
              checked={overridden}
              onChange={() => onToggleOverride(item.path)}
            />
            Optimize anyway
          </label>
        )}
      </td>
      <td className="py-2 text-right text-xs tabular-nums text-muted-foreground">
        {item.output_container}/{item.output_codec}
      </td>
    </tr>
  );
}

export function OptimizationPreviewPanel({
  projection,
  contract,
  overrides,
  onToggleOverride,
}: OptimizationPreviewPanelProps) {
  const { t } = useI18n();
  const [openSample, setOpenSample] = useState<SampleEncode | null>(null);

  const samples = useMemo(() => comparableSamples(projection), [projection]);
  const saving = savingSummary(projection);
  const space = spaceRequirement(projection);

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          {t("optimization.preview.title", undefined, "Optimization preview")}
        </h2>
        <p className="text-sm text-muted-foreground">{modeDisclosure(projection.mode)}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Current size</div>
          <div className="text-sm tabular-nums text-foreground">
            {formatBytesShort(projection.current_bytes)}
          </div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">
            {saving.label ? "Estimated saving" : "Saving"}
          </div>
          <div className="text-sm tabular-nums text-foreground">
            {saving.label ? `${saving.label} (${saving.percentLabel})` : "Unknown"}
          </div>
          {!saving.label && saving.reason && (
            <div className="mt-1 text-2xs text-muted-foreground">{saving.reason}</div>
          )}
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Temporary space</div>
          <div className="text-sm tabular-nums text-foreground">{space.temporaryLabel}</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Quarantine space</div>
          <div className="text-sm tabular-nums text-foreground">{space.quarantineLabel}</div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{space.note}</p>

      {projection.estimate_only ? (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-muted-foreground">
          {t(
            "optimization.preview.estimateOnly",
            undefined,
            "No candidate media was generated, so there is nothing to compare. The figures above are estimates.",
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">
            {t("optimization.preview.samples", undefined, "Generated samples")}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {samples.map((sample) => (
              <li key={sample.source_path}>
                <button
                  type="button"
                  onClick={() => setOpenSample(sample)}
                  className="rounded-lg border border-border px-3 py-2 text-left text-xs hover:border-primary"
                >
                  <span className="block text-foreground">{getBasename(sample.source_path)}</span>
                  <span className="block text-muted-foreground">
                    {formatBytesShort(sample.source_bytes)} →{" "}
                    {formatBytesShort(sample.candidate_bytes)} · {sample.sampling_scope}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(projection.warnings.length > 0 || projection.compatibility_warnings.length > 0) && (
        <ul className="space-y-1 text-xs text-warning">
          {[...projection.warnings, ...projection.compatibility_warnings].map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {projection.failures.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary>{projection.failures.length} sample encode(s) failed</summary>
          <ul className="mt-1 space-y-1">
            {projection.failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">File</th>
              <th className="pb-2 pr-3 text-right font-medium">Now</th>
              <th className="pb-2 pr-3 text-right font-medium">Projected</th>
              <th className="pb-2 pr-3 font-medium">Recommendation</th>
              <th className="pb-2 text-right font-medium">Output</th>
            </tr>
          </thead>
          <tbody>
            {projection.items.map((item) => (
              <ItemRow
                key={item.path}
                item={item}
                overridden={overrides?.has(item.path) ?? false}
                onToggleOverride={onToggleOverride}
              />
            ))}
          </tbody>
        </table>
      </div>

      {openSample && (
        <SampleComparisonModal
          sample={openSample}
          contract={contract}
          samples={samples}
          onClose={() => setOpenSample(null)}
        />
      )}
    </section>
  );
}
