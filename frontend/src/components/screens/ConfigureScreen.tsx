/** Screen 3 — fine-tune the active recipe against its named baseline. */

import { useCallback, useMemo, useState } from "react";
import {
  FiAlertCircle,
  FiArrowLeft,
  FiChevronDown,
  FiLock,
  FiRotateCcw,
  FiSave,
} from "react-icons/fi";

import { CleanGroup } from "@/components/config/groups/CleanGroup";
import { EnrichGroup } from "@/components/config/groups/EnrichGroup";
import { SortGroup } from "@/components/config/groups/SortGroup";
import { CONFIG_GROUPS, CONFIG_RAIL, type GroupId } from "@/components/config/groups";
import { SECTION_FIELDS, type SectionId } from "@/components/config/constants";
import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import {
  SettingsDiffContext,
  type NestedConfigDiff,
  type NestedConfigField,
  type SettingsDiffValue,
} from "@/context/settings-diff-context";
import { SettingsLockContext } from "@/context/settings-lock-context";
import { useConfig } from "@/hooks/useConfig";
import { useConfigDefaults, useSettingsBaseline } from "@/hooks/useConfigDefaults";
import { useConfigSections } from "@/hooks/useConfigSections";
import { useScrollSpy } from "@/hooks/useScrollSpy";
import { useI18n } from "@/i18n/I18nContext";
import { ResetDialog, type ResetDestination, type ResetRow } from "@/components/config/ResetDialog";
import { changedKeys, configFieldLabel, formatConfigValue } from "@/lib/configDiff";
import { INVENTED_SAMPLES, summariesFor, type SampleFile } from "@/lib/configSummary";
import { captureRecipeSettings } from "@/lib/configRecipes";
import { cn } from "@/lib/utils";
import type { Config, RecipeSettings, SavedRecipe } from "@/types/api";

interface ConfigureScreenProps {
  /** Settings are locked while an operation is running. */
  disabled?: boolean;
  /**
   * A calculated plan exists, so the settings are read-only.
   *
   * Separate from `disabled` on purpose. Both make the column read-only, but
   * the shell already renders the lock banner and its way out for this one, so
   * the screen must not repeat it.
   */
  locked?: boolean;
  onSaveConfig: (patch: Partial<Config>) => void;
  onSaveRecipe: (name: string, settings: RecipeSettings) => Promise<void>;
  /** Returns to recipe choice within Setup. */
  onEditRecipe: () => void;
  /** Needed to resolve which recipe the current configuration corresponds to. */
  savedRecipes: SavedRecipe[];
  /**
   * Files from the last dry run. The folder and rename previews are drawn with
   * these where there are any, so the examples are the user's own filenames
   * rather than an invented pair they have to trust behaves like theirs.
   */
  samples?: readonly SampleFile[];
}

const GROUP_BODIES: Record<GroupId, typeof SortGroup> = {
  sort: SortGroup,
  clean: CleanGroup,
  enrich: EnrichGroup,
};

/**
 * Where "the top" is, under the sticky group header. A hair more than the
 * `scroll-mt` a row is given, so a row the rail just scrolled to counts as
 * reached rather than as still-below-the-fold.
 *
 * Three numbers move together: this, the `scroll-mt-[5.5rem]` on a settings row
 * and the `top-4` the group header pins at (`setting-row.tsx`). The header
 * resting 16px down rather than flush adds 16px to the two below it.
 */
const STICKY_HEADER_OFFSET = 104;

/** Every anchor the rail can point at, in document order. */
const SPY_ANCHORS = CONFIG_RAIL.map((entry) => entry.id);

/** Read one object-valued config section without pretending arrays are records. */
function configRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

export function ConfigureScreen({
  disabled = false,
  locked = false,
  onSaveConfig,
  onSaveRecipe,
  onEditRecipe,
  savedRecipes,
  samples,
}: ConfigureScreenProps) {
  /** Read-only for either reason: a run is in flight, or a plan exists. */
  const readOnly = disabled || locked;
  const { t, tCount } = useI18n();
  const { config, isLoading, error, fieldErrors, resetConfig } = useConfig();
  const defaults = useConfigDefaults();
  const sectionMeta = useConfigSections();
  const [naming, setNaming] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [recipeName, setRecipeName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const summaries = useMemo(
    () => (config ? summariesFor(config, t, tCount) : {}),
    [config, t, tCount],
  );
  const [pendingReset, setPendingReset] = useState<{
    title: string;
    destinations: ResetDestination[];
  } | null>(null);

  // The recipe in force, over the factory defaults for everything it does not
  // claim. Both halves come from the backend or from the recipe definitions —
  // never from a mirror in the frontend that would silently drift.
  const baseline = useSettingsBaseline(config, savedRecipes);
  const baselineLabel = baseline.origin
    ? t("config.baseline.recipe", {
        name: baseline.origin.custom ? baseline.origin.labelKey : t(baseline.origin.labelKey),
      })
    : t("config.baseline.defaults");

  const changed = useMemo(
    () => (config && baseline.values ? changedKeys(config, baseline.values) : null),
    [config, baseline.values],
  );

  const sectionFields = useCallback(
    (id: SectionId): string[] => sectionMeta.get(id)?.fields ?? [...SECTION_FIELDS[id]],
    [sectionMeta],
  );

  /** Every `Config` field a group owns, so a reset can aim at any destination. */
  const groupFields = useCallback(
    (group: GroupId): (keyof Config)[] => {
      const sections = CONFIG_GROUPS.find((entry) => entry.id === group)?.sections ?? [];
      return sections.flatMap((section) =>
        defaults ? (sectionFields(section) as (keyof Config)[]) : [...SECTION_FIELDS[section]],
      );
    },
    [defaults, sectionFields],
  );

  const allFields = useCallback(
    (): (keyof Config)[] => CONFIG_GROUPS.flatMap((group) => groupFields(group.id)),
    [groupFields],
  );

  /**
   * A reset states what it would change before changing it — and now says where
   * "back" is, because there are two answers.
   *
   * Only settings that would actually move are listed, and the values are run
   * through the same formatters the settings use — never a raw identifier. A
   * destination with nothing to change is offered and disabled with the reason,
   * rather than silently doing nothing, which is the behaviour users reported as
   * a broken button elsewhere on this screen.
   */
  const destinationFor = useCallback(
    (
      id: string,
      label: string,
      values: Partial<Config> | undefined,
      fields: readonly (keyof Config)[],
    ): ResetDestination | null => {
      if (!config || !values) return null;
      const patch: Partial<Config> = {};
      for (const field of fields) {
        if (field in values) patch[field] = values[field] as never;
      }
      const rows: ResetRow[] = (Object.keys(patch) as (keyof Config)[])
        .filter((key) => JSON.stringify(config[key]) !== JSON.stringify(patch[key]))
        .map((key) => ({
          key: String(key),
          setting: configFieldLabel(key),
          current: formatConfigValue(config[key]),
          result: formatConfigValue(patch[key]),
        }))
        .sort((a, b) => a.setting.localeCompare(b.setting));
      return {
        id,
        label,
        rows,
        patch,
        unavailable:
          rows.length === 0 ? t("config.reset.alreadyThere", { target: label }) : undefined,
      };
    },
    [config, t],
  );

  const askToReset = useCallback(
    (title: string, fields: readonly (keyof Config)[]) => {
      const destinations = [
        // The recipe first: it is the baseline every marker on the screen is
        // measured against, so it is the "back" the reader has in mind. The
        // factory defaults stay reachable — a recipe-relative baseline must not
        // hide the product's own opinion — but they are the second answer.
        baseline.origin ? destinationFor("baseline", baselineLabel, baseline.values, fields) : null,
        destinationFor("defaults", t("config.baseline.defaults"), defaults, fields),
      ].filter((destination): destination is ResetDestination => destination !== null);

      if (destinations.length === 0) return;
      setPendingReset({ title, destinations });
    },
    [baseline.origin, baseline.values, baselineLabel, defaults, destinationFor, t],
  );

  const resetGroup = useCallback(
    (group: GroupId) => {
      const groupLabel = t(`config.group.${group}.label`);
      askToReset(t("config.reset.groupTitle", { group: groupLabel }), groupFields(group));
    },
    [askToReset, groupFields, t],
  );

  const resetAll = useCallback(
    () => askToReset(t("config.reset.allTitle"), allFields()),
    [allFields, askToReset, t],
  );

  /**
   * Put one row's fields back. The same dialog as reset-all and reset-group —
   * a one-line table rather than a different, smaller confirmation, because
   * "what would this change?" has one answer shape everywhere on this screen.
   */
  const revertFields = useCallback(
    (fields: readonly (keyof Config)[]) => askToReset(t("config.reset.rowTitle"), fields),
    [askToReset, t],
  );

  const inspectNested = useCallback(
    (field: NestedConfigField): NestedConfigDiff | null => {
      if (!config || !baseline.values) return null;
      const currentParent = configRecord(config[field.key]);
      const defaultParent = configRecord(baseline.values[field.key]);
      if (!currentParent || !defaultParent) return null;
      const currentValue = currentParent[field.property];
      const defaultValue = defaultParent[field.property];
      return {
        changed: JSON.stringify(currentValue) !== JSON.stringify(defaultValue),
        defaultValue,
      };
    },
    [baseline.values, config],
  );

  const nestedDestinationFor = useCallback(
    (
      id: string,
      label: string,
      values: Partial<Config> | undefined,
      field: NestedConfigField,
    ): ResetDestination | null => {
      if (!config || !values) return null;
      const currentRecord = configRecord(config[field.key]);
      const targetParent = configRecord(values[field.key]);
      if (!currentRecord || !targetParent) return null;
      const targetValue = targetParent[field.property];
      const currentValue = currentRecord[field.property];
      const patch: Partial<Config> = {
        [field.key]: { ...currentRecord, [field.property]: targetValue },
      } as Partial<Config>;
      const changedValue = JSON.stringify(currentValue) !== JSON.stringify(targetValue);
      return {
        id,
        label,
        rows: changedValue
          ? [
              {
                key: `${String(field.key)}.${field.property}`,
                setting: field.label,
                current: formatConfigValue(currentValue),
                result: formatConfigValue(targetValue),
              },
            ]
          : [],
        patch,
        unavailable: changedValue ? undefined : t("config.reset.alreadyThere", { target: label }),
      };
    },
    [config, t],
  );

  const revertNested = useCallback(
    (field: NestedConfigField) => {
      const destinations = [
        baseline.origin
          ? nestedDestinationFor("baseline", baselineLabel, baseline.values, field)
          : null,
        nestedDestinationFor("defaults", t("config.baseline.defaults"), defaults, field),
      ].filter((destination): destination is ResetDestination => destination !== null);
      if (destinations.length > 0) {
        setPendingReset({ title: t("config.reset.rowTitle"), destinations });
      }
    },
    [baseline.origin, baseline.values, baselineLabel, defaults, nestedDestinationFor, t],
  );

  const settingsDiff = useMemo<SettingsDiffValue | null>(
    () =>
      changed && baseline.values
        ? {
            changed,
            defaults: baseline.values,
            baselineLabel,
            revert: revertFields,
            nested: inspectNested,
            revertNested,
            locked: readOnly,
          }
        : null,
    [changed, baseline.values, baselineLabel, revertFields, inspectNested, revertNested, readOnly],
  );

  // A server-side validation error can land on a field the user is not looking
  // at. Flagging the owning group in the rail is how they find it from anywhere.
  const groupHasError = useCallback(
    (group: GroupId): boolean => {
      if (fieldErrors.size === 0) return false;
      const sections = CONFIG_GROUPS.find((entry) => entry.id === group)?.sections ?? [];
      return sections.some((section) => sectionFields(section).some((f) => fieldErrors.has(f)));
    },
    [fieldErrors, sectionFields],
  );

  const groupIsChanged = useCallback(
    (group: GroupId): boolean => {
      if (!changed) return false;
      const sections = CONFIG_GROUPS.find((entry) => entry.id === group)?.sections ?? [];
      return sections.some((section) => sectionFields(section).some((f) => changed.has(f)));
    },
    [changed, sectionFields],
  );

  const openSetting = (anchorId: string) => {
    const target = document.getElementById(anchorId);
    if (!target) return;
    // On a narrow window the rail is a disclosure; selecting a row closes it so
    // the requested setting is immediately visible.
    setRailOpen(false);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    // Move focus too, so keyboard users end up where the click sent everyone else.
    const focusable = target.querySelector<HTMLElement>(
      "input, select, button, [tabindex]:not([tabindex='-1'])",
    );
    focusable?.focus({ preventScroll: true });
  };

  // The rail follows the reader rather than only the last thing they clicked:
  // scrolling to a section marks that section, which is what makes the rail a
  // position indicator instead of a list of links.
  const activeAnchor = useScrollSpy(SPY_ANCHORS, STICKY_HEADER_OFFSET);
  const activeGroup = CONFIG_RAIL.find((entry) => entry.id === activeAnchor)?.group ?? "sort";

  const submitRecipe = async () => {
    if (!config) return;
    const name = recipeName.trim();
    if (!name) return;
    setSaveError(null);
    try {
      await onSaveRecipe(name, captureRecipeSettings(config));
      setNaming(false);
      setRecipeName("");
    } catch {
      setSaveError(t("recipes.saveFailed"));
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy>
        {[...Array(3)].map((_, index) => (
          <div key={index} className="h-40 animate-pulse rounded-window bg-muted" />
        ))}
      </div>
    );
  }

  if (error || !config) {
    return (
      <StateView
        variant="error"
        layout="page"
        title={t("common.settingsUnavailable")}
        detail={t("config.loadFailedHelp")}
        onRetry={resetConfig}
      />
    );
  }

  return (
    <div>
      <ScreenHeader
        eyebrow={t("stage.position", { current: 2, total: 4 })}
        title={
          baseline.origin
            ? t("config.title.recipe", {
                recipe: baseline.origin.custom
                  ? baseline.origin.labelKey
                  : t(baseline.origin.labelKey),
              })
            : t("config.title.custom")
        }
        subtitle={baseline.origin ? t("config.subtitle") : t("config.subtitle.custom")}
        actions={
          <Button data-open-recipes variant="outline" size="sm" onClick={onEditRecipe}>
            <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("config.changeRecipe")}
          </Button>
        }
      />

      {/* Only for a run in flight. The plan lock has the shell's banner, which
          also carries the way out of it. */}
      {disabled && !locked && (
        <div className="mb-4 flex items-start gap-2 rounded-window border border-warning/40 bg-tint-warning px-4 py-3 text-xs text-warning">
          <FiLock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            {t("common.settingsLocked")}
            {/* A quieter second line, but not a faded one: `opacity` on text
                drags contrast-tuned copy below the floor exactly where someone
                is reading it. The weight change carries the hierarchy. */}
            <span className="mt-0.5 block text-3xs font-normal text-warning">
              {t("stage.locked.selectable")}
            </span>
          </span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label={t("config.rail.label")} className="lg:sticky lg:top-4 lg:self-start">
          {/* Below the two-column breakpoint the rail would otherwise be a
              screenful of links standing between the user and the first
              setting, so it folds away. The sticky group headings carry the
              "where am I" job at that width. */}
          <button
            type="button"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((open) => !open)}
            className="mb-2 flex w-full items-center gap-2 rounded-window border border-border bg-card px-4 py-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            {t("config.rail.overview")}
            <span className="flex-1" />
            <FiChevronDown
              aria-hidden
              className={cn("h-3.5 w-3.5 transition-transform", railOpen && "rotate-180")}
            />
          </button>

          <div
            className={cn(
              "rounded-window border border-border bg-card p-2",
              !railOpen && "hidden lg:block",
            )}
          >
            {/* One ruled band per group. The three groups used to run together
                as label-then-links with only 12px between them, so the rail
                read as one long list of ten and the pipeline stages it is
                actually built from were invisible. The rule is what separates
                them; the indent below aligns every label and link to one
                gutter. */}
            {CONFIG_GROUPS.map((group) => (
              <div
                key={group.id}
                className="border-t border-border/70 py-2 first:border-t-0 first:pt-0.5"
              >
                <div className="flex items-baseline gap-2 px-3 pb-2 pt-2">
                  <span
                    id={`config-rail-group-${group.id}`}
                    className={cn(
                      "text-3xs font-bold uppercase tracking-[0.12em] transition-colors",
                      activeGroup === group.id ? "text-primary" : "text-faint",
                    )}
                  >
                    {t(`config.group.${group.id}.label`)}
                  </span>
                  {groupHasError(group.id) && (
                    <FiAlertCircle
                      className="h-3 w-3 text-error"
                      aria-label={t("config.rail.groupHasError")}
                    />
                  )}
                </div>
                {/* `aria-labelledby` on the list, not a named `<section>`: a
                    named section is a `region` landmark, and three of them
                    nested inside the rail's own `<nav>` is a `landmark-unique`
                    failure. The list still gets the group's name. */}
                <ul aria-labelledby={`config-rail-group-${group.id}`} className="grid gap-px">
                  {CONFIG_RAIL.filter((entry) => entry.group === group.id).map((entry) => {
                    const current = activeAnchor === entry.id;
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          onClick={() => openSetting(entry.id)}
                          aria-current={current ? "true" : undefined}
                          className={cn(
                            "relative block w-full rounded-control py-2 pl-4 pr-3 text-left transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            current ? "bg-tint-primary" : "hover:bg-muted",
                          )}
                        >
                          {/* A drawn pill, not an inset box-shadow. A shadow
                              follows the control's 6px radius, so the rail
                              tapered to a point at both ends and read as a
                              crescent rather than a marker. This is a straight
                              3px pill, centred on the row and short of it, and
                              it is the same marker the review queue uses for a
                              selected set. */}
                          {current && (
                            <span
                              aria-hidden
                              className="absolute left-1 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary"
                            />
                          )}
                          <span className="min-w-0">
                            <span
                              className={cn(
                                "block truncate text-2xs font-semibold",
                                current ? "text-primary" : "text-foreground",
                              )}
                            >
                              {t(entry.labelKey)}
                            </span>
                            <span className="mt-0.5 block truncate text-3xs font-normal text-faint">
                              {summaries[entry.id]}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            {/* The actions close the rail, so they take the same rule the
                groups are separated by rather than a heavier one of their own. */}
            <div className="border-t border-border/70 px-1 pb-1 pt-3">
              {naming ? (
                <div className="space-y-2">
                  <label className="block">
                    <span className="sr-only">{t("recipes.nameLabel")}</span>
                    <input
                      autoFocus
                      value={recipeName}
                      maxLength={60}
                      onChange={(event) => setRecipeName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void submitRecipe();
                        if (event.key === "Escape") setNaming(false);
                      }}
                      placeholder={t("recipes.namePlaceholder")}
                      className="w-full rounded-panel border border-border bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                  {saveError && <p className="text-xs text-error">{saveError}</p>}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => void submitRecipe()}
                      disabled={!recipeName.trim()}
                    >
                      {t("common.save")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setNaming(false)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => setNaming(true)}
                  disabled={readOnly}
                  className="w-full"
                >
                  <FiSave className="h-3.5 w-3.5" aria-hidden />
                  {t("recipes.saveAs")}
                </Button>
              )}

              <Button
                variant="ghost"
                onClick={resetAll}
                disabled={readOnly}
                className="mt-2 w-full"
              >
                <FiRotateCcw className="h-3.5 w-3.5" aria-hidden />
                {t("config.reset.all")}
              </Button>
            </div>
          </div>
        </nav>

        {/* A native `fieldset[disabled]` rather than `inert`, because the two
            differ on exactly the thing that matters here: both stop every
            control, and only `inert` also makes the text inside it
            unselectable. A locked setting is a setting you have been sent here
            to *read* — its value, its explanation and the path in it are things
            people copy — so the boundary has to leave the words alone and take
            only the controls. `fieldset` takes them natively: every `input`,
            `select`, `textarea` and `button` below is disabled by the browser
            and picks up its own `:disabled` styling, with no prop threaded
            through forty fields to be forgotten by the forty-first. */}
        {/* The trailing space is what makes the rail honest: without it the last
            two or three settings can never be scrolled to the top of the pane,
            so the rail could never mark them as the one being read. */}
        {/* The read-only boundary, drawn around the settings and nothing else
            — the rail beside it stays live, because navigating to a heading to
            *read* a setting is not editing it. `read-only-region` is the same
            treatment every locked stage now uses; see `index.css`. */}
        <fieldset
          disabled={readOnly}
          className={cn(
            "settings-content m-0 min-w-0 space-y-4 border-0 p-0 pb-[55dvh]",
            readOnly && "read-only-region",
          )}
        >
          <SettingsLockContext.Provider value={readOnly}>
            <SettingsDiffContext.Provider value={settingsDiff}>
              {CONFIG_GROUPS.map((group) => {
                const Body = GROUP_BODIES[group.id];
                return (
                  <Body
                    key={group.id}
                    config={config}
                    updateConfig={readOnly ? () => {} : onSaveConfig}
                    fieldErrors={fieldErrors}
                    samples={samples && samples.length > 0 ? samples : INVENTED_SAMPLES}
                    onReset={
                      groupIsChanged(group.id) && !readOnly ? () => resetGroup(group.id) : undefined
                    }
                  />
                );
              })}
            </SettingsDiffContext.Provider>
          </SettingsLockContext.Provider>
        </fieldset>
      </div>

      <ResetDialog
        open={pendingReset !== null}
        title={pendingReset?.title ?? ""}
        destinations={pendingReset?.destinations ?? []}
        onClose={() => setPendingReset(null)}
        onConfirm={(destination) => {
          onSaveConfig(destination.patch);
          setPendingReset(null);
        }}
      />
    </div>
  );
}
