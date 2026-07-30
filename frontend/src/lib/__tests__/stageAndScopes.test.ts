import { describe, expect, it } from "vitest";

import {
  EMPTY_SCOPES,
  categorize,
  clearRunOverrides,
  effectiveConfig,
  effectiveValue,
  revertRunOverride,
  safetyConsequences,
  scopeBadge,
  searchSettings,
  unsavedState,
  type SettingDefinition,
} from "@/lib/configScopes";
import {
  INITIAL_STATE,
  availableStages,
  goTo,
  isStale,
  readiness,
  reconcile,
  selectView,
  type StageInputs,
} from "@/lib/stageModel";
import {
  applyProfile,
  diffProfile,
  exportProfile,
  parseProfile,
  runSnapshot,
  snapshotSummary,
  type ProfileSource,
} from "@/lib/profileTransfer";

const DEFINITIONS: SettingDefinition[] = [
  {
    key: "language",
    scope: "application",
    label: "Language",
    invalidates: "nothing",
    category: "dates-metadata",
  },
  {
    key: "rename_pattern",
    scope: "profile",
    label: "Rename pattern",
    invalidates: "preview",
    category: "naming-sidecars",
    keywords: ["filename", "template"],
  },
  {
    key: "duplicate_perceptual_threshold",
    scope: "profile",
    label: "Similarity threshold",
    invalidates: "plan",
    category: "similar-media",
    advanced: true,
  },
  {
    key: "dedup_index_path",
    scope: "profile",
    label: "Index location",
    invalidates: "catalog",
    category: "cache-performance",
    advanced: true,
  },
];

describe("effectiveValue", () => {
  it("prefers a run override over the saved value", () => {
    const scopes = {
      ...EMPTY_SCOPES,
      profile: { rename_pattern: "a" },
      run: { rename_pattern: "b" },
    };

    const setting = effectiveValue(DEFINITIONS[1], scopes);

    expect(setting.value).toBe("b");
    expect(setting.source).toBe("run");
    expect(setting.overridden).toBe(true);
    expect(setting.savedValue).toBe("a");
  });

  it("falls back to the saved value, then to the default", () => {
    const saved = effectiveValue(DEFINITIONS[1], {
      ...EMPTY_SCOPES,
      profile: { rename_pattern: "a" },
    });
    const fallback = effectiveValue(DEFINITIONS[1], EMPTY_SCOPES, { rename_pattern: "d" });

    expect(saved.source).toBe("profile");
    expect(fallback.source).toBe("default");
    expect(fallback.value).toBe("d");
  });

  it("reads an application setting from the application scope", () => {
    const setting = effectiveValue(DEFINITIONS[0], {
      ...EMPTY_SCOPES,
      application: { language: "de" },
    });

    expect(setting.source).toBe("application");
  });

  it("does not call a run value an override when nothing was saved", () => {
    const setting = effectiveValue(DEFINITIONS[1], {
      ...EMPTY_SCOPES,
      run: { rename_pattern: "b" },
    });

    expect(setting.source).toBe("run");
    expect(setting.overridden).toBe(false);
  });

  it("resolves a whole config at once", () => {
    const config = effectiveConfig(DEFINITIONS, EMPTY_SCOPES, { language: "en" });

    expect(Object.keys(config)).toHaveLength(4);
    expect(config.language.value).toBe("en");
  });
});

describe("scope badges", () => {
  it("says plainly when a value is temporary", () => {
    const badge = scopeBadge(
      effectiveValue(DEFINITIONS[1], { ...EMPTY_SCOPES, run: { rename_pattern: "b" } }),
    );

    expect(badge.label).toBe("this run");
    expect(badge.title).toMatch(/not be saved/i);
  });

  it("distinguishes library settings from app preferences", () => {
    expect(
      scopeBadge(
        effectiveValue(DEFINITIONS[1], { ...EMPTY_SCOPES, profile: { rename_pattern: "a" } }),
      ).label,
    ).toBe("library");
    expect(
      scopeBadge(
        effectiveValue(DEFINITIONS[0], { ...EMPTY_SCOPES, application: { language: "de" } }),
      ).label,
    ).toBe("app");
  });
});

describe("unsavedState", () => {
  it("reports the strongest invalidation of the pending changes", () => {
    const state = unsavedState(
      DEFINITIONS,
      { rename_pattern: "a", dedup_index_path: "/x" },
      { rename_pattern: "b", dedup_index_path: "/y" },
    );

    expect(state.count).toBe(2);
    expect(state.impact).toBe("catalog");
    expect(state.summary).toMatch(/index will be rebuilt/i);
  });

  it("says everything is saved when nothing changed", () => {
    expect(
      unsavedState(DEFINITIONS, { rename_pattern: "a" }, { rename_pattern: "a" }).summary,
    ).toBe("Everything is saved.");
  });

  it("ignores keys that are not settings", () => {
    expect(unsavedState(DEFINITIONS, {}, { not_a_setting: 1 }).count).toBe(0);
  });
});

describe("run overrides", () => {
  it("reverting one lets the saved value show through", () => {
    const scopes = {
      ...EMPTY_SCOPES,
      profile: { rename_pattern: "a" },
      run: { rename_pattern: "b" },
    };

    const reverted = revertRunOverride(scopes, "rename_pattern");

    expect(effectiveValue(DEFINITIONS[1], reverted).value).toBe("a");
  });

  it("clearing them all leaves the saved values intact", () => {
    const scopes = {
      ...EMPTY_SCOPES,
      profile: { rename_pattern: "a" },
      run: { rename_pattern: "b" },
    };

    expect(clearRunOverrides(scopes).profile.rename_pattern).toBe("a");
    expect(clearRunOverrides(scopes).run).toEqual({});
  });
});

describe("categories and search", () => {
  it("groups settings in the declared order", () => {
    const categories = categorize(DEFINITIONS);

    expect(categories.map((category) => category.id)).toEqual([
      "dates-metadata",
      "naming-sidecars",
      "similar-media",
      "cache-performance",
    ]);
  });

  it("marks a category advanced only when every setting in it is", () => {
    const categories = categorize(DEFINITIONS);

    expect(categories.find((category) => category.id === "similar-media")?.advanced).toBe(true);
    expect(categories.find((category) => category.id === "naming-sidecars")?.advanced).toBe(false);
  });

  it("searches labels, keys, and keywords", () => {
    expect(searchSettings(DEFINITIONS, "template")).toHaveLength(1);
    expect(searchSettings(DEFINITIONS, "THRESHOLD")).toHaveLength(1);
    expect(searchSettings(DEFINITIONS, "")).toHaveLength(4);
    expect(searchSettings(DEFINITIONS, "nothing at all")).toHaveLength(0);
  });
});

describe("safetyConsequences", () => {
  it("warns about Move mode and about writing inside files", () => {
    const consequences = safetyConsequences({
      copy_instead_of_move: {
        key: "",
        value: false,
        source: "profile",
        overridden: false,
        savedValue: false,
        invalidates: "nothing",
      },
      embed_tags_in_files: {
        key: "",
        value: true,
        source: "profile",
        overridden: false,
        savedValue: true,
        invalidates: "nothing",
      },
    });

    expect(consequences.map((item) => item.severity)).toEqual(["warning", "warning"]);
    expect(consequences[0].text).toMatch(/leave their source folders/i);
  });

  it("states that duplicates are quarantined rather than deleted", () => {
    const consequences = safetyConsequences({
      remove_duplicates: {
        key: "",
        value: true,
        source: "profile",
        overridden: false,
        savedValue: true,
        invalidates: "nothing",
      },
    });

    expect(consequences[0].text).toMatch(/never deleted/i);
  });

  it("says nothing when nothing risky is enabled", () => {
    expect(safetyConsequences({})).toEqual([]);
  });
});

// ── Stage model ──────────────────────────────────────────────────────────────

const READY: StageInputs = {
  rootsReady: true,
  rootsReason: null,
  scanned: true,
  reviewed: true,
  reviewedReason: null,
  blocked: false,
  blockedReason: null,
};

describe("stage readiness", () => {
  it("lets Sources be entered always", () => {
    expect(readiness("sources", { ...READY, rootsReady: false }).canEnter).toBe(true);
  });

  it("blocks Review until the folders are chosen and scanned", () => {
    expect(readiness("review", { ...READY, rootsReady: false }).reason).toMatch(/input folder/i);
    expect(readiness("review", { ...READY, scanned: false }).reason).toMatch(/scan/i);
  });

  it("blocks Execute until something has been reviewed", () => {
    expect(readiness("execute", { ...READY, reviewed: false }).canEnter).toBe(false);
  });

  it("reports a hard block ahead of a missing prerequisite", () => {
    const result = readiness("execute", {
      ...READY,
      rootsReady: false,
      blocked: true,
      blockedReason: "An interrupted run needs your decision.",
    });

    expect(result.reason).toMatch(/interrupted run/i);
  });

  it("lists exactly the stages that can be entered", () => {
    expect(availableStages(READY)).toEqual(["sources", "review", "execute"]);
    expect(availableStages({ ...READY, scanned: false })).toEqual(["sources"]);
  });
});

describe("stage transitions", () => {
  const atExecute = { ...INITIAL_STATE, stage: "execute" as const };

  it("says what going back to Sources invalidates", () => {
    const transition = goTo(atExecute, "sources");

    expect(transition.state.stage).toBe("sources");
    expect(transition.invalidated.join(" ")).toMatch(/makes the current review stale/i);
    expect(transition.invalidated.join(" ")).toMatch(/frozen plan/i);
  });

  it("invalidates nothing when moving forward", () => {
    expect(goTo(INITIAL_STATE, "review").invalidated).toEqual([]);
  });

  it("falls back to the stage's first view for an invalid one", () => {
    expect(goTo(INITIAL_STATE, "review", "exact").state.view).toBe("exact");
    expect(goTo(INITIAL_STATE, "sources", "exact").state.view).toBe("overview");
  });

  it("refuses a view the current stage does not have", () => {
    const state = { ...INITIAL_STATE, stage: "sources" as const };

    expect(selectView(state, "similar")).toBe(state);
  });
});

describe("stage reconciliation", () => {
  const key = { profileId: "p1", catalogGeneration: 3, planVersion: 2, taskId: null };

  it("hydrates a fresh shell without leaving Sources", () => {
    expect(reconcile(INITIAL_STATE, key)).toEqual({
      state: { ...INITIAL_STATE, key },
      invalidated: [],
    });
  });

  it("keeps state that still matches the world", () => {
    const state = { ...INITIAL_STATE, key };

    expect(isStale(state, key)).toBe(false);
    expect(reconcile(state, key).invalidated).toEqual([]);
  });

  it("returns to Review and explains every reason", () => {
    const state = { ...INITIAL_STATE, stage: "execute" as const, key };

    const transition = reconcile(state, { ...key, catalogGeneration: 4, planVersion: 3 });

    expect(transition.state.stage).toBe("review");
    expect(transition.invalidated).toHaveLength(2);
  });

  it("notices a different profile", () => {
    const state = { ...INITIAL_STATE, key };

    expect(reconcile(state, { ...key, profileId: "p2" }).invalidated[0]).toMatch(/profile/i);
  });
});

// ── Profile transfer ─────────────────────────────────────────────────────────

const SOURCE: ProfileSource = {
  profileId: "p1",
  name: "Family photos",
  transferMode: "copy",
  settings: { rename_pattern: "a", duplicate_perceptual_threshold: 4 },
  roots: [
    {
      rootId: "r1",
      role: "input",
      path: "/Users/someone/Pictures/Camera",
      displayName: null,
      priority: 0,
      exclusions: [],
    },
  ],
  catalogMode: "application_data",
};

describe("exportProfile", () => {
  it("never carries an absolute path off the machine", () => {
    const exported = exportProfile(SOURCE);

    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("/Users/someone");
    expect(exported.roots[0].hint).toBe("Camera");
  });

  it("carries roles, priorities, and exclusions", () => {
    const exported = exportProfile(SOURCE);

    expect(exported.roots[0].role).toBe("input");
    expect(exported.transfer_mode).toBe("copy");
  });
});

describe("parseProfile", () => {
  it("rejects a file from another version rather than guessing", () => {
    const { profile, problems } = parseProfile(JSON.stringify({ version: 99 }));

    expect(profile).toBeNull();
    expect(problems[0].kind).toBe("version");
  });

  it("rejects something that is not a profile at all", () => {
    expect(parseProfile("not json").problems[0].kind).toBe("shape");
    expect(parseProfile("[]").profile).toBeNull();
  });

  it("reports settings this build does not know", () => {
    const exported = exportProfile(SOURCE);
    exported.settings.mystery = 1;

    const { problems } = parseProfile(JSON.stringify(exported), ["rename_pattern"]);

    expect(problems.some((problem) => problem.kind === "unknown_setting")).toBe(true);
  });

  it("accepts a profile it wrote itself", () => {
    expect(parseProfile(JSON.stringify(exportProfile(SOURCE))).profile).not.toBeNull();
  });
});

describe("diffProfile", () => {
  it("shows only what would change, and what that costs", () => {
    const exported = exportProfile(SOURCE);
    const diff = diffProfile(exported, DEFINITIONS, {
      ...EMPTY_SCOPES,
      profile: { rename_pattern: "a", duplicate_perceptual_threshold: 9 },
    });

    expect(diff.changes.map((change) => change.key)).toEqual(["duplicate_perceptual_threshold"]);
    expect(diff.unchanged).toBe(1);
    expect(diff.impact).toBe("plan");
  });

  it("never diffs an application preference", () => {
    const exported = exportProfile({ ...SOURCE, settings: { language: "de" } });

    expect(diffProfile(exported, DEFINITIONS, EMPTY_SCOPES).changes).toEqual([]);
  });

  it("says how many folders must be located", () => {
    const diff = diffProfile(exportProfile(SOURCE), DEFINITIONS, EMPTY_SCOPES);

    expect(diff.rootsNeedingLocation).toHaveLength(1);
    expect(diff.summary).toMatch(/1 folder must be located/);
  });

  it("applying clears run overrides so nothing stale survives", () => {
    const applied = applyProfile(exportProfile(SOURCE), {
      ...EMPTY_SCOPES,
      run: { rename_pattern: "temporary" },
    });

    expect(applied.run).toEqual({});
    expect(applied.profile.rename_pattern).toBe("a");
  });
});

describe("runSnapshot", () => {
  it("records the effective settings and any overrides", () => {
    const snapshot = runSnapshot(SOURCE, { ...EMPTY_SCOPES, run: { rename_pattern: "b" } }, 7);

    expect(snapshot.overrides).toEqual(["rename_pattern"]);
    expect(snapshot.effectiveKey).toContain('rename_pattern="b"');
    expect(snapshot.catalogGeneration).toBe(7);
  });

  it("keeps absolute paths out of the snapshot", () => {
    const snapshot = runSnapshot(SOURCE, EMPTY_SCOPES, 1);

    expect(JSON.stringify(snapshot)).not.toContain("/Users/someone");
    expect(snapshot.roots[0].hint).toBe("Camera");
  });

  it("summarises itself for a report header", () => {
    expect(snapshotSummary(runSnapshot(SOURCE, EMPTY_SCOPES, 1))).toBe(
      "Family photos · copy · no run overrides",
    );
  });
});
