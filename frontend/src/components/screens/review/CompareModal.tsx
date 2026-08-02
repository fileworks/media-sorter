/**
 * Two copies, side by side, so the choice is made by looking rather than by
 * reading numbers.
 *
 * Three modes because three different questions get asked: Slide answers "is
 * this the same picture", Side-by-side answers "which one is framed better",
 * Difference answers "did anything actually change". The facts table underneath
 * marks which side wins each individual comparison, which is the part people
 * actually decide on when the images look identical.
 */

import { useRef, useState } from "react";
import { FiX } from "react-icons/fi";

import { Segmented } from "@/components/ui/setting-row";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import { getBasename } from "@/lib/pathUtils";
import { cn } from "@/lib/utils";
import { factLabel, resolutionLabel, type GroupMember } from "@/lib/reviewWorkbench";
import { api } from "@/services/api";

type Mode = "slide" | "side" | "difference";

interface CompareModalProps {
  a: GroupMember;
  b: GroupMember;
  /** Which side the plan currently keeps. */
  keeperId: string | null;
  onKeep: (memberId: string) => void;
  onKeepBoth: () => void;
  onClose: () => void;
}

/** One comparison row, with the winning side marked. */
function FactRow({
  label,
  left,
  right,
  winner,
}: {
  label: string;
  left: string;
  right: string;
  winner: "a" | "b" | null;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr_1fr] gap-2.5 border-b border-border px-5 py-2 text-xs last:border-b-0">
      <span className="text-faint">{label}</span>
      <span className={cn(winner === "a" ? "font-semibold text-success" : "text-foreground")}>
        {left}
      </span>
      <span className={cn(winner === "b" ? "font-semibold text-success" : "text-foreground")}>
        {right}
      </span>
    </div>
  );
}

/** Compare two numbers, tolerating either being unknown. */
function larger(a: number | null, b: number | null): "a" | "b" | null {
  if (a === null || b === null || a === b) return null;
  return a > b ? "a" : "b";
}

function pixels(member: GroupMember): number | null {
  const { width, height } = member.facts;
  if (!width.known || !height.known) return null;
  return Number(width.value) * Number(height.value);
}

function capturedAt(member: GroupMember): number | null {
  const value = member.facts.captured_at;
  if (!value.known || typeof value.value !== "string") return null;
  const parsed = Date.parse(value.value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function CompareModal({
  a,
  b,
  keeperId,
  onKeep,
  onKeepBoth,
  onClose,
}: CompareModalProps) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<Mode>("slide");
  const [split, setSplit] = useState(50);
  const [diffBroken, setDiffBroken] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

  const nameA = getBasename(a.relative_path);
  const nameB = getBasename(b.relative_path);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("review.compare.title")}
      onKeyDown={(event) => event.key === "Escape" && onClose()}
    >
      <div
        ref={panelRef}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-card"
      >
        <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-3">
          <h2 className="text-xs font-bold text-foreground">{t("review.compare.title")}</h2>
          <span className="truncate text-xs text-faint">
            {nameA} · {nameB}
          </span>
          <span className="flex-1" />
          <Segmented
            name="compare-mode"
            label={t("review.compare.mode")}
            value={mode}
            options={[
              { value: "slide", label: t("review.compare.slide") },
              { value: "side", label: t("review.compare.side") },
              { value: "difference", label: t("review.compare.difference") },
            ]}
            onChange={setMode}
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="rounded-lg p-1.5 text-faint transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FiX className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="relative h-64 shrink-0 bg-background">
          {mode === "difference" ? (
            diffBroken ? (
              <p className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
                {t("review.compare.diffUnavailable")}
              </p>
            ) : (
              <img
                src={api.diffUrl(a.observed_path, b.observed_path, 800)}
                alt={t("review.compare.diffAlt", { a: nameA, b: nameB })}
                onError={() => setDiffBroken(true)}
                className="h-full w-full object-contain"
              />
            )
          ) : mode === "side" ? (
            <div className="grid h-full grid-cols-2 gap-px bg-border">
              <Thumbnail path={a.observed_path} maxPx={800} className="h-full w-full" />
              <Thumbnail path={b.observed_path} maxPx={800} className="h-full w-full" />
            </div>
          ) : (
            <>
              <Thumbnail path={b.observed_path} maxPx={800} className="absolute inset-0 h-full w-full" />
              <div
                className="absolute inset-y-0 left-0 overflow-hidden"
                style={{ width: `${split}%` }}
              >
                <Thumbnail
                  path={a.observed_path}
                  maxPx={800}
                  className="h-full w-[calc(100vw)] max-w-none"
                />
              </div>
              <div
                className="pointer-events-none absolute inset-y-0 w-0.5 bg-brand"
                style={{ left: `${split}%` }}
                aria-hidden
              />
              <label className="absolute inset-x-0 bottom-3 px-6">
                <span className="sr-only">{t("review.compare.splitLabel")}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={split}
                  onChange={(event) => setSplit(Number(event.target.value))}
                  className="w-full"
                />
              </label>
            </>
          )}

          <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-success px-2.5 py-0.5 text-3xs font-bold text-white">
            {t("review.compare.sideA", { state: keeperId === a.member_id ? "•" : "" })}
          </span>
          <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-muted px-2.5 py-0.5 text-3xs font-bold text-muted-foreground">
            {t("review.compare.sideB", { state: keeperId === b.member_id ? "•" : "" })}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-[7rem_1fr_1fr] gap-2.5 border-b border-border px-5 py-2 text-3xs font-semibold uppercase tracking-[0.07em] text-faint">
            <span />
            <span className="truncate">{t("review.compare.columnA", { name: nameA })}</span>
            <span className="truncate">{t("review.compare.columnB", { name: nameB })}</span>
          </div>
          <FactRow
            label={t("review.column.date")}
            left={factLabel(a.facts.captured_at)}
            right={factLabel(b.facts.captured_at)}
            winner={larger(capturedAt(a), capturedAt(b))}
          />
          <FactRow
            label={t("review.column.resolution")}
            left={resolutionLabel(a.facts)}
            right={resolutionLabel(b.facts)}
            winner={larger(pixels(a), pixels(b))}
          />
          <FactRow
            label={t("review.column.size")}
            left={formatBytes(a.facts.size_bytes, { locale })}
            right={formatBytes(b.facts.size_bytes, { locale })}
            winner={larger(a.facts.size_bytes, b.facts.size_bytes)}
          />
          <FactRow
            label={t("review.column.location")}
            left={a.relative_path}
            right={b.relative_path}
            winner={null}
          />
          <FactRow
            label={t("review.column.evidence")}
            left={t(`review.confidenceValue.${a.evidence.confidence}`)}
            right={t(`review.confidenceValue.${b.evidence.confidence}`)}
            winner={null}
          />
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <span className="flex-1 text-xs text-faint">{t("review.compare.scopeNote")}</span>
          <button
            type="button"
            onClick={() => onKeep(a.member_id)}
            className="rounded-lg bg-success px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("review.compare.keepA")}
          </button>
          <button
            type="button"
            onClick={() => onKeep(b.member_id)}
            className="rounded-lg border border-border px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("review.compare.keepB")}
          </button>
          <button
            type="button"
            onClick={onKeepBoth}
            className="rounded-lg border border-border px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("review.compare.keepBoth")}
          </button>
        </footer>
      </div>
    </div>
  );
}
