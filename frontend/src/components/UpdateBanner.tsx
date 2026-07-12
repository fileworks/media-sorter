import { useState } from "react";
import { FiDownload, FiX, FiInfo } from "react-icons/fi";
import { cn } from "@/lib/utils";
import { openExternal } from "@/lib/reveal";
import type { UpdateInfo } from "@/services/api";

interface UpdateBannerProps {
  info: UpdateInfo;
}

const DISMISS_KEY = "mediasort_dismissed_version";

function getDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function setDismissedVersion(version: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    // localStorage unavailable — silently ignore.
  }
}

export function UpdateBanner({ info }: UpdateBannerProps) {
  const [showNotes, setShowNotes] = useState(false);
  const [dismissed, setDismissed] = useState(() => getDismissedVersion() === info.latest_version);

  if (!info.update_available || dismissed || !info.latest_version) return null;

  function handleDismiss() {
    if (info.latest_version) setDismissedVersion(info.latest_version);
    setDismissed(true);
  }

  function handleDownload() {
    if (info.release_url) openExternal(info.release_url);
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        <FiInfo className="shrink-0 h-4 w-4 text-primary" />
        <span className="text-primary">
          <span className="font-semibold">MediaSorter {info.latest_version}</span> is available —
          you&apos;re on {info.current_version}.
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {info.release_notes && (
            <button
              type="button"
              onClick={() => setShowNotes((n) => !n)}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-primary/80 hover:bg-primary/15"
            >
              {showNotes ? "Hide notes" : "What's new"}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            className={cn(
              "flex items-center gap-1.5 rounded-md border border-primary/30",
              "bg-primary/15 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/25",
            )}
          >
            <FiDownload className="h-3 w-3" />
            Download
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss update notification"
            className="rounded-md p-1 text-primary/60 hover:bg-primary/15 hover:text-primary"
          >
            <FiX className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showNotes && info.release_notes && (
        <pre className="mt-1 max-h-48 overflow-y-auto rounded-lg bg-muted p-3 text-xs text-foreground/80 whitespace-pre-wrap font-sans">
          {info.release_notes}
        </pre>
      )}
    </div>
  );
}
