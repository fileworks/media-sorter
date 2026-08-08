/**
 * Three groups, in the order the work actually happens.
 *
 * 01 Sort decides how a file travels and where it lands. 02 Clean decides what
 * is set aside on the way. 03 Enrich decides what is added once it has landed.
 * That ordering is not a filing convention — it is the pipeline, and naming the
 * groups after it is why somebody can predict which group a setting is in.
 *
 * Each rail entry is an anchor to a row plus a one-line summary of that row's
 * current value, so the rail answers "what is this run going to do?" without
 * anything being expanded.
 */

import type { SectionId } from "@/components/config/constants";
import { PROVENANCE_DECISION_KINDS, type ProvenanceDecision } from "@/services/api";

export type GroupId = "sort" | "clean" | "enrich";

export interface GroupMeta {
  id: GroupId;
  ordinal: string;
  /** Config sections whose defaults this group's "reset" restores. */
  sections: SectionId[];
}

export const CONFIG_GROUPS: GroupMeta[] = [
  { id: "sort", ordinal: "01", sections: ["essentials", "folders", "rename"] },
  { id: "clean", ordinal: "02", sections: ["duplicates", "filters"] },
  { id: "enrich", ordinal: "03", sections: ["conversion", "ai", "rules", "other"] },
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
