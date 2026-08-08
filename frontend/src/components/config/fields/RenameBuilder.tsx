/**
 * The rename pattern, and what it does to real filenames.
 *
 * The preview used to show only the *result* — one line per file kind, no sign
 * of what it started from — which made the two things a rename can surprise you
 * with invisible: a pattern without `NAME` gives every file from the same day
 * the same name, and conversion rewrites the extension underneath you. Both are
 * now rows in a before-and-after table rather than sentences somewhere else.
 */

import { useState, useEffect, useRef } from "react";
import { FiCamera, FiCopy, FiFilm } from "react-icons/fi";

import { Tooltip } from "@/components/ui/tooltip";
import { ValidationBadge } from "@/components/ui/validation-badge";
import {
  RENAME_TOKENS,
  renderPatternParts,
  validateRenamePattern,
  type PatternPart,
} from "@/lib/renamePattern";
import { exampleFilename, predictedExtension, type SampleFile } from "@/lib/configSummary";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import type { Config } from "@/types/api";

/**
 * A pattern with no `NAME` token resolves to the same string for every file
 * that shares a date and a kind, so the second one onward is given the
 * deterministic `_001` suffix `reserve_destination` appends. This is the only
 * collision the preview can demonstrate honestly: the others depend on what is
 * already on the destination disk.
 */
function collidesByPattern(pattern: string): boolean {
  return !pattern.includes("NAME");
}

/** The name the second file of a colliding pair gets — `reserve_destination`'s. */
function withCollisionSuffix(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? `${filename.slice(0, dot)}_001${filename.slice(dot)}` : `${filename}_001`;
}

function PreviewRow({
  icon,
  before,
  after,
  note,
}: {
  icon: React.ReactNode;
  before: string;
  after: PatternPart[] | string;
  note?: string;
}) {
  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="py-1 pr-3">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {icon}
          <span className="break-all">{before}</span>
        </span>
      </td>
      <td className="py-1">
        <span className="break-all text-foreground">
          {typeof after === "string"
            ? after
            : after.map((part, index) => (
                <span key={index} className={part.isToken ? "font-medium text-primary" : undefined}>
                  {part.text}
                </span>
              ))}
        </span>
        {note && <span className="ml-2 whitespace-nowrap text-3xs text-faint">{note}</span>}
      </td>
    </tr>
  );
}

export function RenameBuilder({
  config,
  samples,
  onCommit,
}: {
  config: Config;
  samples: readonly SampleFile[];
  onCommit: (value: string) => void;
}) {
  const { t } = useI18n();
  const configPattern = config.rename_pattern;
  const [local, setLocal] = useState(configPattern);
  const prevConfigRef = useRef(configPattern);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (configPattern !== prevConfigRef.current) {
      prevConfigRef.current = configPattern;
      setLocal(configPattern);
    }
  }, [configPattern]);

  const commit = (value: string) => {
    setLocal(value);
    onCommit(value);
  };

  const insertToken = (token: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? local.length;
    const end = el?.selectionEnd ?? local.length;
    const next = local.slice(0, start) + token + local.slice(end);
    commit(next);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = start + token.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const val = validateRenamePattern(local);
  // The table previews the pattern being typed, not the one last committed.
  const draft: Config = { ...config, rename: true, rename_pattern: local };
  const first = samples[0];

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        id="rename-pattern"
        value={local}
        onChange={(event) => commit(event.target.value)}
        placeholder="TYPE_YYYY-MM-DD"
        className={cn(
          "block w-full rounded-md border border-input bg-background px-3 py-2",
          "font-mono text-sm text-foreground placeholder:text-muted-foreground",
          "focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring",
        )}
      />

      <div className="flex flex-wrap gap-1">
        {RENAME_TOKENS.map((token) => (
          <Tooltip
            key={token.token}
            label={t("common.example", {
              label: t(token.labelKey, {}, token.label),
              example: token.example,
            })}
          >
            <button
              type="button"
              onClick={() => insertToken(token.token)}
              className="rounded-md border border-input bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-foreground transition-colors hover:border-faint hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {token.token}
            </button>
          </Tooltip>
        ))}
      </div>

      {val.error && (
        <ValidationBadge message={t(val.errorKey ?? "", {}, val.error)} severity="error" />
      )}
      {val.warning && (
        <ValidationBadge message={t(val.warningKey ?? "", {}, val.warning)} severity="warning" />
      )}

      {!val.error && local && (
        <div className="overflow-x-auto rounded-md bg-muted/30 p-2">
          <table className="w-full text-left font-mono text-xs">
            <thead>
              <tr className="border-b border-border text-3xs uppercase tracking-[0.08em] text-faint">
                <th scope="col" className="py-1 pr-3 font-sans font-medium">
                  {t("config.rename.before")}
                </th>
                <th scope="col" className="py-1 font-sans font-medium">
                  {t("config.rename.after")}
                </th>
              </tr>
            </thead>
            <tbody>
              {samples.map((sample) => (
                <PreviewRow
                  key={`${sample.stem}${sample.extension}`}
                  icon={
                    sample.kind === "VID" ? (
                      <FiFilm className="h-3 w-3 shrink-0" aria-hidden />
                    ) : (
                      <FiCamera className="h-3 w-3 shrink-0" aria-hidden />
                    )
                  }
                  before={`${sample.stem}${sample.extension}`}
                  after={renderPatternParts(
                    local,
                    sample.date ?? new Date(),
                    sample.stem,
                    predictedExtension(draft, sample),
                    sample.kind,
                  )}
                  note={
                    predictedExtension(draft, sample).toLowerCase() !==
                    sample.extension.toLowerCase()
                      ? t("config.rename.converted")
                      : undefined
                  }
                />
              ))}
              {first && collidesByPattern(local) && (
                <PreviewRow
                  icon={<FiCopy className="h-3 w-3 shrink-0" aria-hidden />}
                  before={t("config.rename.collisionBefore")}
                  after={withCollisionSuffix(exampleFilename(draft, first))}
                  note={t("config.rename.collisionNote")}
                />
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {RENAME_TOKENS.map((token) => (
          <span key={token.token}>
            <code className="font-medium text-primary">{token.token}</code> → {token.example}
          </span>
        ))}
      </div>
    </div>
  );
}
