import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";

interface FolderBrowserDialogProps {
  open: boolean;
  onClose: () => void;
  /** Where to start. Empty opens at the platform roots. */
  initialPath?: string;
  /** True for a destination, where a folder must also be writable. */
  requireWritable?: boolean;
  onSelect: (path: string) => void;
}

/**
 * The browser build's folder picker.
 *
 * Every listing comes from `/api/fs/list`, which is also what validates a
 * configured root — so a folder this dialog lets you choose is one the run will
 * accept, and the two cannot drift apart.
 */
export function FolderBrowserDialog({
  open,
  onClose,
  initialPath = "",
  requireWritable = false,
  onSelect,
}: FolderBrowserDialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState(initialPath);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setPath(initialPath);
      setCursor(0);
    }
  }, [open, initialPath]);

  const listing = useQuery({
    queryKey: ["fs", "list", path],
    queryFn: () => api.listDirectory(path),
    enabled: open,
  });

  const entries = listing.data?.entries ?? [];
  const parent = listing.data?.parent ?? null;

  const descend = useCallback((next: string) => {
    setPath(next);
    setCursor(0);
  }, []);

  const ascend = useCallback(() => {
    if (parent !== null) descend(parent);
    else if (path !== "") descend("");
  }, [parent, path, descend]);

  // Arrow keys move, Enter descends, Backspace ascends. Escape is the modal's.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((index) => Math.min(index + 1, Math.max(entries.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      const entry = entries[cursor];
      if (entry && entry.readable) {
        event.preventDefault();
        descend(entry.path);
      }
    } else if (event.key === "Backspace") {
      event.preventDefault();
      ascend();
    }
  };

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [cursor, entries.length]);

  const failure = listing.error
    ? extractErrorMessage(listing.error, t("folderBrowser.failed"))
    : null;
  const crumbs = path === "" ? [] : path.split(/[\\/]+/).filter(Boolean);
  const notWritable = requireWritable && listing.data !== undefined && !listing.data.writable;
  const unreadable = listing.data !== undefined && !listing.data.readable;
  const canUse = path !== "" && !unreadable && !notWritable && !listing.isError;

  const blockedReason = unreadable
    ? t("folderBrowser.unreadable")
    : notWritable
      ? t("folderBrowser.notWritable")
      : path === ""
        ? t("folderBrowser.pickAFolder")
        : undefined;

  return (
    <Modal open={open} onClose={onClose} title={t("folderBrowser.title")} size="lg">
      <ModalHeader />
      <ModalBody className="space-y-3">
        <nav aria-label={t("folderBrowser.breadcrumb")} className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => descend("")}
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("folderBrowser.roots")}
          </button>
          {crumbs.map((crumb, index) => {
            const upto = path.startsWith("/")
              ? `/${crumbs.slice(0, index + 1).join("/")}`
              : crumbs.slice(0, index + 1).join("/");
            return (
              <span key={upto} className="flex items-center gap-1">
                <span aria-hidden className="text-muted-foreground">
                  /
                </span>
                <button
                  type="button"
                  onClick={() => descend(upto)}
                  className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {crumb}
                </button>
              </span>
            );
          })}
        </nav>

        {listing.isPending && <StateView variant="loading" compact title={t("state.loading")} />}

        {listing.isError && failure && (
          <StateView
            variant="error"
            compact
            title={t("folderBrowser.failed")}
            detail={failure.message}
            code={failure.code}
            onRetry={() => void listing.refetch()}
          />
        )}

        {listing.data && unreadable && (
          <StateView variant="blocked" compact title={t("folderBrowser.unreadable")} />
        )}

        {listing.data && !unreadable && entries.length === 0 && (
          <StateView variant="empty" compact title={t("folderBrowser.empty")} />
        )}

        {listing.data && entries.length > 0 && (
          <ul
            ref={listRef}
            role="listbox"
            aria-label={t("folderBrowser.folders")}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="max-h-80 overflow-y-auto rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {entries.map((entry, index) => (
              <li key={entry.path}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === cursor}
                  data-active={index === cursor}
                  disabled={!entry.readable}
                  onClick={() => {
                    setCursor(index);
                    if (entry.readable) descend(entry.path);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-2 text-left text-sm",
                    index === cursor && "bg-accent",
                    entry.readable ? "hover:bg-accent" : "cursor-not-allowed opacity-60",
                  )}
                >
                  <span className="truncate">{entry.name}</span>
                  {!entry.readable && (
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {t("folderBrowser.locked")}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {blockedReason ?? path}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!canUse}
              title={canUse ? undefined : blockedReason}
              onClick={() => {
                onSelect(path);
                onClose();
              }}
            >
              {t("folderBrowser.use")}
            </Button>
          </div>
        </div>
      </ModalFooter>
    </Modal>
  );
}
