/**
 * Three places a setting can come from, and never any confusion about which.
 *
 * *Application preferences* belong to this installation — language, theme,
 * update checks. *Library profile* settings belong to the library and travel
 * with a saved profile. *This-run overrides* belong to the next run only and are
 * forgotten afterwards.
 *
 * The point is that every control can say where its current value came from, and
 * what changing it would invalidate. A user who cannot tell whether a setting is
 * saved or temporary will eventually be surprised by one of them.
 */

export type Scope = "application" | "profile" | "run";

/** What must be recomputed when a setting changes. */
export type Invalidation = "nothing" | "preview" | "plan" | "catalog";

export interface SettingDefinition {
  key: string;
  scope: Scope;
  label: string;
  /** What a change costs, so the UI can say so before the change is made. */
  invalidates: Invalidation;
  /** Categories the settings screen groups by. */
  category: string;
  advanced?: boolean;
  /** Words a search should match beyond the label. */
  keywords?: string[];
}

export interface ScopedValues {
  application: Record<string, unknown>;
  profile: Record<string, unknown>;
  run: Record<string, unknown>;
}

export interface EffectiveSetting {
  key: string;
  value: unknown;
  /** Where the winning value came from. */
  source: Scope | "default";
  /** True when a run override is masking a saved value. */
  overridden: boolean;
  savedValue: unknown;
  invalidates: Invalidation;
}

export const EMPTY_SCOPES: ScopedValues = { application: {}, profile: {}, run: {} };

/**
 * Resolve one setting across the scopes.
 *
 * Precedence is run → profile → application → default, which is the order of
 * decreasing specificity: a value chosen for this run is the most deliberate
 * thing the user has said.
 */
export function effectiveValue(
  definition: SettingDefinition,
  scopes: ScopedValues,
  defaults: Record<string, unknown> = {},
): EffectiveSetting {
  const saved =
    definition.scope === "application"
      ? scopes.application[definition.key]
      : scopes.profile[definition.key];
  const hasRun = definition.key in scopes.run;

  let value: unknown;
  let source: Scope | "default";
  if (hasRun) {
    value = scopes.run[definition.key];
    source = "run";
  } else if (saved !== undefined) {
    value = saved;
    source = definition.scope;
  } else {
    value = defaults[definition.key];
    source = "default";
  }

  return {
    key: definition.key,
    value,
    source,
    overridden: hasRun && saved !== undefined && saved !== scopes.run[definition.key],
    savedValue: saved,
    invalidates: definition.invalidates,
  };
}

export function effectiveConfig(
  definitions: SettingDefinition[],
  scopes: ScopedValues,
  defaults: Record<string, unknown> = {},
): Record<string, EffectiveSetting> {
  return Object.fromEntries(
    definitions.map((definition) => [definition.key, effectiveValue(definition, scopes, defaults)]),
  );
}

export interface UnsavedState {
  /** Profile keys changed but not saved. */
  keys: string[];
  count: number;
  /** The strongest invalidation any pending change carries. */
  impact: Invalidation;
  summary: string;
}

const IMPACT_ORDER: Invalidation[] = ["nothing", "preview", "plan", "catalog"];

const IMPACT_TEXT: Record<Invalidation, string> = {
  nothing: "Nothing needs to be redone.",
  preview: "The preview will be recomputed.",
  plan: "Review decisions for affected groups will need looking at again.",
  catalog: "Part of the index will be rebuilt on the next scan.",
};

/** What is pending, and what saving it would cost. */
export function unsavedState(
  definitions: SettingDefinition[],
  saved: Record<string, unknown>,
  draft: Record<string, unknown>,
): UnsavedState {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const keys = Object.keys(draft).filter(
    (key) => byKey.has(key) && !Object.is(draft[key], saved[key]),
  );
  const impact = keys.reduce<Invalidation>((worst, key) => {
    const current = byKey.get(key)?.invalidates ?? "nothing";
    return IMPACT_ORDER.indexOf(current) > IMPACT_ORDER.indexOf(worst) ? current : worst;
  }, "nothing");

  return {
    keys,
    count: keys.length,
    impact,
    summary:
      keys.length === 0
        ? "Everything is saved."
        : `${keys.length} unsaved change${keys.length === 1 ? "" : "s"}. ${IMPACT_TEXT[impact]}`,
  };
}

/** Drop a run override so the saved value shows through again. */
export function revertRunOverride(scopes: ScopedValues, key: string): ScopedValues {
  const run = { ...scopes.run };
  delete run[key];
  return { ...scopes, run };
}

export function clearRunOverrides(scopes: ScopedValues): ScopedValues {
  return { ...scopes, run: {} };
}

export interface ScopeBadge {
  label: string;
  tone: "neutral" | "info" | "warning";
  title: string;
}

/** The little label beside a control that says where its value came from. */
export function scopeBadge(setting: EffectiveSetting): ScopeBadge {
  switch (setting.source) {
    case "run":
      return {
        label: "this run",
        tone: "warning",
        title: setting.overridden
          ? "Overrides the saved value for the next run only."
          : "Set for the next run only; it will not be saved.",
      };
    case "profile":
      return { label: "library", tone: "info", title: "Saved with this library profile." };
    case "application":
      return {
        label: "app",
        tone: "neutral",
        title: "An application preference for this machine.",
      };
    default:
      return { label: "default", tone: "neutral", title: "The built-in default." };
  }
}

// ── Categories and search ────────────────────────────────────────────────────

export interface Category {
  id: string;
  label: string;
  advanced: boolean;
  settings: SettingDefinition[];
}

/**
 * The category order a settings screen renders.
 *
 * Basic categories come first and are always expanded; advanced ones are
 * searchable but collapsed, because a setting nobody can find is as good as
 * missing while a screen of ninety controls is as good as unusable.
 */
export const CATEGORY_ORDER = [
  "dates-metadata",
  "naming-sidecars",
  "exact-duplicates",
  "similar-media",
  "validation",
  "cache-performance",
  "quarantine",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  "dates-metadata": "Dates & metadata",
  "naming-sidecars": "Naming & sidecars",
  "exact-duplicates": "Exact duplicates",
  "similar-media": "Similar media",
  validation: "Validation",
  "cache-performance": "Cache & performance",
  quarantine: "Quarantine",
};

export function categorize(definitions: SettingDefinition[]): Category[] {
  const grouped = new Map<string, SettingDefinition[]>();
  for (const definition of definitions) {
    const list = grouped.get(definition.category) ?? [];
    list.push(definition);
    grouped.set(definition.category, list);
  }
  const known = CATEGORY_ORDER.filter((id) => grouped.has(id));
  const extra = [...grouped.keys()].filter(
    (id) => !(CATEGORY_ORDER as readonly string[]).includes(id),
  );
  return [...known, ...extra.sort()].map((id) => {
    const settings = grouped.get(id) ?? [];
    return {
      id,
      label: CATEGORY_LABELS[id] ?? id,
      advanced: settings.every((setting) => setting.advanced === true),
      settings,
    };
  });
}

/** Search matches labels, keys, and declared keywords — case-insensitively. */
export function searchSettings(
  definitions: SettingDefinition[],
  query: string,
): SettingDefinition[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return definitions;
  return definitions.filter((definition) =>
    [definition.label, definition.key, ...(definition.keywords ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

// ── Safety consequences ──────────────────────────────────────────────────────

export interface SafetyConsequence {
  key: string;
  text: string;
  severity: "info" | "warning";
}

/**
 * The sentences that must survive into the run summary.
 *
 * A setting whose consequence is only visible on the settings screen is a
 * setting whose consequence the user has forgotten by the time they press Sort.
 */
export function safetyConsequences(
  effective: Record<string, EffectiveSetting>,
): SafetyConsequence[] {
  const consequences: SafetyConsequence[] = [];
  const value = (key: string) => effective[key]?.value;

  if (value("copy_instead_of_move") === false) {
    consequences.push({
      key: "copy_instead_of_move",
      text: "Move mode: files leave their source folders once each copy is verified.",
      severity: "warning",
    });
  }
  if (value("remove_duplicates") === true) {
    consequences.push({
      key: "remove_duplicates",
      text: "Duplicates are moved to quarantine, never deleted.",
      severity: "info",
    });
  }
  if (value("junk_filter_enabled") === true) {
    consequences.push({
      key: "junk_filter_enabled",
      text: "Thumbnails and small files are quarantined, not discarded.",
      severity: "info",
    });
  }
  if (value("embed_tags_in_files") === true) {
    consequences.push({
      key: "embed_tags_in_files",
      text: "Tags are written inside your files — this changes the file itself.",
      severity: "warning",
    });
  }
  if (value("repair_enabled") === true) {
    consequences.push({
      key: "repair_enabled",
      text: "Repair rewrites damaged media; the original is kept in quarantine.",
      severity: "warning",
    });
  }
  return consequences;
}
