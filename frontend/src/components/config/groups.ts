/** Configure groups in pipeline order, with compact summaries for the rail. */

import type { SectionId } from "@/components/config/constants";
import { PROVENANCE_DECISION_KINDS, type ProvenanceDecision } from "@/services/api";

export type GroupId = "sort" | "clean" | "enrich";

export interface GroupMeta {
  id: GroupId;
  /** Config sections whose defaults this group's "reset" restores. */
  sections: SectionId[];
}

export const CONFIG_GROUPS: GroupMeta[] = [
  { id: "sort", sections: ["essentials", "folders", "rename"] },
  { id: "clean", sections: ["duplicates", "filters"] },
  { id: "enrich", sections: ["conversion", "ai", "rules", "other"] },
];

export interface RailEntry {
  /** Anchor id of the row this jumps to. */
  id: string;
  group: GroupId;
  labelKey: string;
  /** Destination decisions owned by the setting row this rail entry opens. */
  provenanceDecisions?: readonly ProvenanceDecision[];
}

export const CONFIG_RAIL: RailEntry[] = [
  { id: "setting-transfer", group: "sort", labelKey: "config.rail.transfer" },
  {
    id: "setting-structure",
    group: "sort",
    labelKey: "config.rail.structure",
    provenanceDecisions: ["date", "source_subfolder", "camera"],
  },
  {
    id: "setting-naming",
    group: "sort",
    labelKey: "config.rail.naming",
    provenanceDecisions: ["rename", "original_name"],
  },
  { id: "setting-duplicates", group: "clean", labelKey: "config.rail.duplicates" },
  { id: "setting-junk", group: "clean", labelKey: "config.rail.junk" },
  { id: "setting-scan", group: "clean", labelKey: "config.rail.scan" },
  {
    id: "setting-conversion",
    group: "enrich",
    labelKey: "config.rail.conversion",
    provenanceDecisions: ["conversion"],
  },
  {
    id: "setting-ai",
    group: "enrich",
    labelKey: "config.rail.ai",
    provenanceDecisions: ["category"],
  },
  {
    id: "setting-rules",
    group: "enrich",
    labelKey: "config.rail.rules",
    provenanceDecisions: ["route"],
  },
  { id: "setting-maintenance", group: "enrich", labelKey: "config.rail.maintenance" },
];

/** Decisions that describe an outcome rather than a configurable input. */
export const PROVENANCE_DECISIONS_WITHOUT_SETTING = new Set<ProvenanceDecision>([
  "collision",
  "quarantine",
]);

/**
 * Resolve attribution through the same rail Configure renders.
 *
 * The ownership lives on `CONFIG_RAIL`, rather than in a parallel jump table,
 * so changing an anchor cannot leave Review pointing at a row that no longer
 * exists. A decision with no governing setting deliberately resolves to null.
 */
export function settingAnchorForDecision(decision: ProvenanceDecision): string | null {
  return CONFIG_RAIL.find((entry) => entry.provenanceDecisions?.includes(decision))?.id ?? null;
}

/** Exported for the contract test that makes newly added backend kinds fail. */
export function provenanceDecisionCoverage(): Array<{
  decision: ProvenanceDecision;
  anchor: string | null;
}> {
  return PROVENANCE_DECISION_KINDS.map((decision) => ({
    decision,
    anchor: settingAnchorForDecision(decision),
  }));
}
