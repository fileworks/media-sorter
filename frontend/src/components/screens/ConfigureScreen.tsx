/**
 * Screen 2 — fine-tune the recipe.
 *
 * The rail on the left is not navigation for its own sake: each entry carries
 * the *current value* of the setting it jumps to, so reading the rail top to
 * bottom answers "what is this run going to do?" without opening anything. That
 * is the screen's real job; the jumping is a side effect.
 *
 * Settings that deviate from the defaults are marked in the rail and can be put
 * back one group at a time, because a user who has been experimenting needs a
 * way out that is narrower than "reset everything".
 */

import { useCallback, useMemo, useState } from "react";
import { FiAlertCircle, FiChevronDown, FiLock, FiRotateCcw, FiSave } from "react-icons/fi";

import { CleanGroup } from "@/components/config/groups/CleanGroup";
import { EnrichGroup } from "@/components/config/groups/EnrichGroup";
import { SortGroup } from "@/components/config/groups/SortGroup";
import { CONFIG_GROUPS, CONFIG_RAIL, type GroupId } from "@/components/config/groups";
import { SECTION_DEFAULTS, type SectionId } from "@/components/config/constants";
import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { StateView } from "@/components/StateView";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfig } from "@/hooks/useConfig";
import { useConfigDefaults } from "@/hooks/useConfigDefaults";
import { useConfigSections } from "@/hooks/useConfigSections";
import { useScrollSpy } from "@/hooks/useScrollSpy";
import { useI18n } from "@/i18n/I18nContext";
import { changedKeys } from "@/lib/configDiff";
import { summariesFor } from "@/lib/configSummary";
import { captureRecipeSettings } from "@/lib/configRecipes";
import { cn } from "@/lib/utils";
import type { Config, RecipeSettings } from "@/types/api";

interface ConfigureScreenProps {
  /** Settings are locked while an operation is running. */
  disabled?: boolean;
  onSaveConfig: (patch: Partial<Config>) => void;
  onSaveRecipe: (name: string, settings: RecipeSettings) => Promise<void>;
  /** Bumped by the caller to remount the bodies after a discarded edit. */
  bodyKey?: number;
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
 */
const STICKY_HEADER_OFFSET = 88;

/** Every anchor the rail can point at, in document order. */
const SPY_ANCHORS = CONFIG_RAIL.map((entry) => entry.id);

export function ConfigureScreen({
  disabled = false,
  onSaveConfig,
  onSaveRecipe,
  bodyKey = 0,
}: ConfigureScreenProps) {
  const { t } = useI18n();
  const { config, isLoading, error, fieldErrors, resetConfig } = useConfig();
  const defaults = useConfigDefaults();
  const sectionMeta = useConfigSections();
  const [naming, setNaming] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [recipeName, setRecipeName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const summaries = useMemo(() => (config ? summariesFor(config, t) : {}), [config, t]);

  // "Deviates from the factory default" is answered by the backend's own
  // defaults, never by a mirror in the frontend that would silently drift.
  const changed = useMemo(
    () => (config && defaults ? changedKeys(config, defaults) : null),
    [config, defaults],
  );

  const sectionFields = useCallback(
    (id: SectionId): string[] =>
      sectionMeta.get(id)?.fields ?? Object.keys(SECTION_DEFAULTS[id] ?? {}),
    [sectionMeta],
  );

  const resetGroup = useCallback(
    (group: GroupId) => {
      const sections = CONFIG_GROUPS.find((entry) => entry.id === group)?.sections ?? [];
      const patch: Partial<Config> = {};
      for (const section of sections) {
        if (defaults) {
          for (const field of sectionFields(section)) {
            if (field in defaults)
              patch[field as keyof Config] = defaults[field as keyof Config] as never;
          }
        } else {
          Object.assign(patch, SECTION_DEFAULTS[section]);
        }
      }
      onSaveConfig(patch);
    },
    [defaults, onSaveConfig, sectionFields],
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

  const jumpTo = (anchorId: string) => {
    const target = document.getElementById(anchorId);
    if (!target) return;
    // On a narrow window the rail is a disclosure; jumping means it has done
    // its job and should get out of the way of what it jumped to.
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
          <div key={index} className="h-40 animate-pulse rounded-xl bg-muted" />
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
      <ScreenHeader title={t("config.title")} subtitle={t("config.subtitle")} />

      {disabled && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-warning/40 bg-tint-warning px-3.5 py-2.5 text-xs text-warning">
          <FiLock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("common.settingsLocked")}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
        <nav aria-label={t("config.rail.label")} className="lg:sticky lg:top-4 lg:self-start">
          {/* Below the two-column breakpoint the rail would otherwise be a
              screenful of links standing between the user and the first
              setting, so it folds away. The sticky group headings carry the
              "where am I" job at that width. */}
          <button
            type="button"
            aria-expanded={railOpen}
            onClick={() => setRailOpen((open) => !open)}
            className="mb-2 flex w-full items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            {t("config.rail.jumpTo")}
            <span className="flex-1" />
            <FiChevronDown
              aria-hidden
              className={cn("h-3.5 w-3.5 transition-transform", railOpen && "rotate-180")}
            />
          </button>

          <div
            className={cn(
              "rounded-xl border border-border bg-card p-2",
              !railOpen && "hidden lg:block",
            )}
          >
            {CONFIG_GROUPS.map((group) => (
              <div key={group.id}>
                <div className="flex items-baseline gap-2 px-2.5 pb-1 pt-3">
                  <span className="font-mono text-3xs font-bold text-primary">{group.ordinal}</span>
                  <span
                    className={cn(
                      "text-3xs font-bold uppercase tracking-[0.1em]",
                      activeGroup === group.id ? "text-foreground" : "text-faint",
                    )}
                  >
                    {t(`config.group.${group.id}.label`)}
                  </span>
                  <span className="flex-1" />
                  {groupHasError(group.id) && (
                    <FiAlertCircle
                      className="h-3 w-3 text-error"
                      aria-label={t("config.rail.groupHasError")}
                    />
                  )}
                  {groupIsChanged(group.id) && !disabled && (
                    <Tooltip label={t("config.rail.resetGroup")}>
                      <button
                        type="button"
                        onClick={() => resetGroup(group.id)}
                        className="rounded-md p-1 text-faint transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <FiRotateCcw className="h-3 w-3" aria-hidden />
                      </button>
                    </Tooltip>
                  )}
                </div>
                <ul>
                  {CONFIG_RAIL.filter((entry) => entry.group === group.id).map((entry) => {
                    const current = activeAnchor === entry.id;
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          onClick={() => jumpTo(entry.id)}
                          aria-current={current ? "true" : undefined}
                          className={cn(
                            "flex w-full flex-col gap-0.5 rounded-lg border-l-2 px-2.5 py-1.5 text-left transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            current
                              ? "border-brand bg-tint-primary"
                              : "border-transparent hover:bg-muted",
                          )}
                        >
                          <span
                            className={cn(
                              "text-xs font-semibold",
                              current ? "text-primary" : "text-foreground",
                            )}
                          >
                            {t(entry.labelKey)}
                          </span>
                          <span className="truncate text-xs text-faint">{summaries[entry.id]}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            <div className="mt-3 border-t border-border p-1 pt-3">
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
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </label>
                  {saveError && <p className="text-xs text-error">{saveError}</p>}
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => void submitRecipe()}
                      disabled={!recipeName.trim()}
                      className="flex-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                    >
                      {t("common.save")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setNaming(false)}
                      className="rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setNaming(true)}
                  disabled={disabled}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <FiSave className="h-3.5 w-3.5" aria-hidden />
                  {t("recipes.saveAs")}
                </button>
              )}
            </div>
          </div>
        </nav>

        {/* `inert` also blocks keyboard focus — `pointer-events-none` alone
            would leave the locked inputs tab-reachable. It takes a real boolean:
            React 19 reads an empty string as `false`, which silently left the
            settings editable while they looked locked. */}
        {/* The trailing space is what makes the rail honest: without it the last
            two or three settings can never be scrolled to the top of the pane,
            so the rail could never mark them as the one being read. */}
        <div
          key={bodyKey}
          className={cn("min-w-0 space-y-4 pb-[55dvh]", disabled && "select-none opacity-60")}
          inert={disabled}
        >
          {CONFIG_GROUPS.map((group) => {
            const Body = GROUP_BODIES[group.id];
            return (
              <Body
                key={group.id}
                config={config}
                updateConfig={disabled ? () => {} : onSaveConfig}
                fieldErrors={fieldErrors}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
