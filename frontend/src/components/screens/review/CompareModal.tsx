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

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { MediaImage } from "@/components/ui/media-image";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/setting-row";
import { Thumbnail } from "@/components/ui/thumbnail";
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
    <div className="grid grid-cols-[5rem_1fr_1fr] gap-2.5 border-b border-border px-5 py-2 text-xs last:border-b-0 sm:grid-cols-[7rem_1fr_1fr]">
      <span className="text-faint">{label}</span>
      <span className={cn("break-words", winner === "a" ? "font-semibold text-success" : "text-foreground")}>
        {left}
      </span>
      <span className={cn("break-words", winner === "b" ? "font-semibold text-success" : "text-foreground")}>
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

  const nameA = getBasename(a.relative_path);
  const nameB = getBasename(b.relative_path);

  return (
    <Modal open onClose={onClose} title={t("review.compare.title")} size="lg">
      <ModalHeader
        actions={
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
        }
      >
        <span className="min-w-0 truncate text-xs text-faint">
          {nameA} · {nameB}
        </span>
      </ModalHeader>

      <div className="relative h-56 shrink-0 bg-background sm:h-64">
        {mode === "difference" ? (
          <MediaImage
            src={api.diffUrl(a.observed_path, b.observed_path, 800)}
            alt={t("review.compare.diffAlt", { a: nameA, b: nameB })}
            className="h-full w-full object-contain"
            fallback={
              <p className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
                {t("review.compare.diffUnavailable")}
              </p>
            }
          />
        ) : mode === "side" ? (
          <div className="grid h-full grid-cols-2 gap-px bg-border">
            <Thumbnail path={a.observed_path} maxPx={800} className="h-full w-full" />
            <Thumbnail path={b.observed_path} maxPx={800} className="h-full w-full" />
          </div>
        ) : (
          <>
            <Thumbnail
              path={b.observed_path}
              maxPx={800}
              className="absolute inset-0 h-full w-full"
            />
            {/* Clipping rather than resizing: both images stay laid out at the
                full panel width, so the slider reveals the same pixels the
                other side is showing instead of a differently-scaled copy. */}
            <div
              className="absolute inset-0"
              style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
            >
              <Thumbnail
                path={a.observed_path}
                maxPx={800}
                className="absolute inset-0 h-full w-full"
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

      <ModalBody className="px-0 py-0">
        <div className="grid grid-cols-[5rem_1fr_1fr] gap-2.5 border-b border-border px-5 py-2 text-3xs font-semibold uppercase tracking-[0.07em] text-faint sm:grid-cols-[7rem_1fr_1fr]">
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
      </ModalBody>

      <ModalFooter>
        <span className="mr-auto min-w-0 text-xs text-faint">
          {t("review.compare.scopeNote")}
        </span>
        <Button size="sm" variant="outline" onClick={onKeepBoth}>
          {t("review.compare.keepBoth")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onKeep(b.member_id)}>
          {t("review.compare.keepB")}
        </Button>
        <Button size="sm" onClick={() => onKeep(a.member_id)}>
          {t("review.compare.keepA")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
