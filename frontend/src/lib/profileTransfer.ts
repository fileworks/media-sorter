/**
 * Exporting a library profile, and importing one without surprises.
 *
 * An exported profile carries settings and root *roles* — never absolute paths
 * to somebody else's disk, and never a catalog. Importing shows a scoped diff
 * first: what would change, in which scope, and what that would invalidate. A
 * profile that applied itself silently would be a way to lose a review.
 */

import type { Invalidation, Scope, SettingDefinition, ScopedValues } from "./configScopes";

export const PROFILE_EXPORT_VERSION = 1;

export type RootRole = "input" | "reference" | "destination";

export interface ExportedRoot {
  root_id: string;
  role: RootRole;
  display_name: string | null;
  /** The last path segment only — enough to recognise, not enough to relocate. */
  hint: string;
  priority: number;
  exclusions: string[];
}

export interface ExportedProfile {
  version: number;
  profile_id: string;
  name: string;
  exported_at: string;
  transfer_mode: "copy" | "move";
  settings: Record<string, unknown>;
  roots: ExportedRoot[];
  /** Portable catalogs are opted into on import, never carried in the file. */
  catalog_mode: "application_data" | "portable";
}

export interface ProfileSource {
  profileId: string;
  name: string;
  transferMode: "copy" | "move";
  settings: Record<string, unknown>;
  roots: {
    rootId: string;
    role: RootRole;
    path: string;
    displayName: string | null;
    priority: number;
    exclusions: string[];
  }[];
  catalogMode: "application_data" | "portable";
}

function hint(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Build the export payload. Absolute paths never leave the machine. */
export function exportProfile(source: ProfileSource, now: Date = new Date()): ExportedProfile {
  return {
    version: PROFILE_EXPORT_VERSION,
    profile_id: source.profileId,
    name: source.name,
    exported_at: now.toISOString(),
    transfer_mode: source.transferMode,
    settings: { ...source.settings },
    roots: source.roots.map((root) => ({
      root_id: root.rootId,
      role: root.role,
      display_name: root.displayName,
      hint: hint(root.path),
      priority: root.priority,
      exclusions: [...root.exclusions],
    })),
    catalog_mode: source.catalogMode,
  };
}

export interface ImportProblem {
  kind: "version" | "shape" | "unknown_setting";
  detail: string;
}

export interface ParsedProfile {
  profile: ExportedProfile | null;
  problems: ImportProblem[];
}

/** Parse and validate an exported profile without applying any of it. */
export function parseProfile(raw: string, knownKeys: string[] = []): ParsedProfile {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { profile: null, problems: [{ kind: "shape", detail: "this is not a profile file" }] };
  }
  if (typeof payload !== "object" || payload === null) {
    return { profile: null, problems: [{ kind: "shape", detail: "this is not a profile file" }] };
  }
  const candidate = payload as Partial<ExportedProfile>;
  const problems: ImportProblem[] = [];

  if (candidate.version !== PROFILE_EXPORT_VERSION) {
    problems.push({
      kind: "version",
      detail: `this profile was written by another version (${String(candidate.version)})`,
    });
    return { profile: null, problems };
  }
  if (typeof candidate.profile_id !== "string" || !Array.isArray(candidate.roots)) {
    problems.push({ kind: "shape", detail: "the profile is missing its identity or its roots" });
    return { profile: null, problems };
  }
  if (knownKeys.length > 0) {
    for (const key of Object.keys(candidate.settings ?? {})) {
      if (!knownKeys.includes(key)) {
        problems.push({
          kind: "unknown_setting",
          detail: `${key} is not a setting this build knows`,
        });
      }
    }
  }
  return { profile: candidate as ExportedProfile, problems };
}

export interface DiffEntry {
  key: string;
  scope: Scope;
  label: string;
  current: unknown;
  incoming: unknown;
  invalidates: Invalidation;
}

export interface ProfileDiff {
  changes: DiffEntry[];
  unchanged: number;
  /** Roots that must be pointed at a real folder before the profile can run. */
  rootsNeedingLocation: ExportedRoot[];
  /** The strongest invalidation the import would cause. */
  impact: Invalidation;
  summary: string;
}

const IMPACT_ORDER: Invalidation[] = ["nothing", "preview", "plan", "catalog"];

/**
 * What importing would change, scope by scope.
 *
 * Application preferences are deliberately excluded: a profile describes a
 * library, not somebody's theme or language.
 */
export function diffProfile(
  profile: ExportedProfile,
  definitions: SettingDefinition[],
  scopes: ScopedValues,
): ProfileDiff {
  const changes: DiffEntry[] = [];
  let unchanged = 0;

  for (const definition of definitions) {
    if (definition.scope !== "profile") continue;
    if (!(definition.key in profile.settings)) continue;
    const incoming = profile.settings[definition.key];
    const current = scopes.profile[definition.key];
    if (Object.is(incoming, current)) {
      unchanged += 1;
      continue;
    }
    changes.push({
      key: definition.key,
      scope: "profile",
      label: definition.label,
      current,
      incoming,
      invalidates: definition.invalidates,
    });
  }

  const impact = changes.reduce<Invalidation>(
    (worst, change) =>
      IMPACT_ORDER.indexOf(change.invalidates) > IMPACT_ORDER.indexOf(worst)
        ? change.invalidates
        : worst,
    "nothing",
  );

  return {
    changes,
    unchanged,
    rootsNeedingLocation: profile.roots,
    impact,
    summary:
      changes.length === 0
        ? "This profile matches your current settings."
        : `${changes.length} setting${changes.length === 1 ? "" : "s"} would change; ` +
          `${profile.roots.length} folder${profile.roots.length === 1 ? "" : "s"} must be located.`,
  };
}

/** Apply an import into the profile scope. Roots are located separately. */
export function applyProfile(profile: ExportedProfile, scopes: ScopedValues): ScopedValues {
  return { ...scopes, profile: { ...scopes.profile, ...profile.settings }, run: {} };
}

export interface RunSnapshot {
  profileId: string;
  profileName: string;
  transferMode: "copy" | "move";
  catalogGeneration: number;
  /** Hash-like identity of the settings this run will use. */
  effectiveKey: string;
  overrides: string[];
  roots: { role: RootRole; hint: string }[];
  createdAt: string;
}

/**
 * The immutable record of what a run was actually configured with.
 *
 * It is stored beside the result so a report can answer "what settings produced
 * this?" months later, when the profile has moved on.
 */
export function runSnapshot(
  source: ProfileSource,
  scopes: ScopedValues,
  catalogGeneration: number,
  now: Date = new Date(),
): RunSnapshot {
  const merged = { ...source.settings, ...scopes.profile, ...scopes.run };
  const effectiveKey = Object.keys(merged)
    .sort()
    .map((key) => `${key}=${JSON.stringify(merged[key])}`)
    .join("|");
  return {
    profileId: source.profileId,
    profileName: source.name,
    transferMode: source.transferMode,
    catalogGeneration,
    effectiveKey,
    overrides: Object.keys(scopes.run).sort(),
    roots: source.roots.map((root) => ({ role: root.role, hint: hint(root.path) })),
    createdAt: now.toISOString(),
  };
}

export function snapshotSummary(snapshot: RunSnapshot): string {
  const overrides =
    snapshot.overrides.length === 0
      ? "no run overrides"
      : `${snapshot.overrides.length} run override${snapshot.overrides.length === 1 ? "" : "s"}`;
  return `${snapshot.profileName} · ${snapshot.transferMode} · ${overrides}`;
}
