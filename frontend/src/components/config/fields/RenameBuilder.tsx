import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/tooltip";
import { ValidationBadge } from "@/components/ui/validation-badge";
import {
  RENAME_TOKENS,
  renderPatternParts,
  validateRenamePattern,
  type PatternPart,
} from "@/lib/renamePattern";
import { FiCamera, FiFilm } from "react-icons/fi";
import { EXAMPLE_DATE } from "@/components/config/constants";
import { useI18n } from "@/i18n/I18nContext";

function RenamePreviewRow({
  icon,
  label,
  parts,
}: {
  icon: React.ReactNode;
  label: string;
  parts: PatternPart[];
}) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-xs">
      {icon}
      <span className="text-muted-foreground">{label}:</span>
      <span>
        {parts.map((p, i) => (
          <span key={i} className={p.isToken ? "font-medium text-primary" : "text-foreground"}>
            {p.text}
          </span>
        ))}
      </span>
    </div>
  );
}

export function RenameBuilder({
  configPattern,
  onCommit,
}: {
  configPattern: string;
  onCommit: (v: string) => void;
}) {
  const { t } = useI18n();
  const [local, setLocal] = useState(configPattern);
  const prevConfigRef = useRef(configPattern);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (configPattern !== prevConfigRef.current) {
      prevConfigRef.current = configPattern;
      setLocal(configPattern);
    }
  }, [configPattern]);

  const commit = (v: string) => {
    setLocal(v);
    onCommit(v);
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

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        id="rename-pattern"
        value={local}
        onChange={(e) => commit(e.target.value)}
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
            label={t(
              "common.example",
              {
                label: t(token.labelKey, {}, token.label),
                example: token.example,
              },
              `${token.label} — e.g. ${token.example}`,
            )}
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
        <div className="space-y-0.5 rounded-md bg-muted/30 p-2">
          <RenamePreviewRow
            icon={<FiCamera className="h-3 w-3 shrink-0" />}
            label={t("config.rename.photo")}
            parts={renderPatternParts(local, EXAMPLE_DATE, "IMG_001", ".jpg", "IMG")}
          />
          <RenamePreviewRow
            icon={<FiFilm className="h-3 w-3 shrink-0" />}
            label={t("config.rename.video")}
            parts={renderPatternParts(local, EXAMPLE_DATE, "VID_0042", ".mp4", "VID")}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {RENAME_TOKENS.map((t) => (
          <span key={t.token}>
            <code className="font-medium text-primary">{t.token}</code> → {t.example}
          </span>
        ))}
      </div>
    </div>
  );
}
