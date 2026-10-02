import { useEffect, useMemo, useState } from "react";
import type { BrowseEntry, SetEntry } from "@/lib/reviewBrowse";

/** Keep a decision's controls in place until the reader changes browse context. */
export function useBrowsePlacement(entries: BrowseEntry[], sets: SetEntry[], context: string) {
  const [anchors, setAnchors] = useState<ReadonlyMap<string, string> | null>(null);
  useEffect(() => setAnchors(null), [context]);
  const displayed = useMemo(() => {
    // Keep-all normally dissolves a set into files. Retain its live decision
    // card until refresh too, without displaying those files a second time.
    const retained = sets.filter(
      (entry) => entry.decisionKind === "keep_all" && anchors?.has(entry.key),
    );
    const retainedIds = new Set(retained.map((entry) => entry.id));
    return [
      ...entries.filter(
        (entry) =>
          entry.kind !== "file" || !entry.row.stack || !retainedIds.has(entry.row.stack.id),
      ),
      ...retained,
    ].map((entry) => {
      const folder = anchors?.get(entry.key);
      return folder === undefined || folder === entry.folder ? entry : { ...entry, folder };
    });
  }, [anchors, entries, sets]);
  return {
    entries: displayed,
    pinned: anchors !== null,
    pin: () =>
      setAnchors(
        (current) => current ?? new Map(entries.map((entry) => [entry.key, entry.folder])),
      ),
    refresh: () => setAnchors(null),
  };
}
