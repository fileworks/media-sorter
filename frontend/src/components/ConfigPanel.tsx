import { useMemo, useState, type ReactNode } from "react";
import { useConfig } from "@/hooks/useConfig";
import { useConfigSections } from "@/hooks/useConfigSections";
import { useConfigDefaults } from "@/hooks/useConfigDefaults";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { FiLock } from "react-icons/fi";
import type { Config } from "@/types/api";
import { SECTION_DEFAULTS, isSectionDirty, type SectionId } from "@/components/config/constants";
import { changedKeys, diffConfig } from "@/lib/configDiff";
import { SECTION_META } from "@/components/config/sectionMeta";
import { SettingsRail } from "@/components/config/fields/SettingsRail";
import { ChangedFromDefaults } from "@/components/config/fields/ChangedFromDefaults";
import { ResetButton } from "@/components/config/fields/ResetButton";
import { EssentialsSection } from "@/components/config/sections/EssentialsSection";
import { FoldersSection } from "@/components/config/sections/FoldersSection";
import { DuplicatesSection } from "@/components/config/sections/DuplicatesSection";
import { RenameSection } from "@/components/config/sections/RenameSection";
import { ConversionSection } from "@/components/config/sections/ConversionSection";
import { FiltersSection } from "@/components/config/sections/FiltersSection";
import { RulesSection } from "@/components/config/sections/RulesSection";
import { AiSection } from "@/components/config/sections/AiSection";
import { OtherSection } from "@/components/config/sections/OtherSection";
import type { SectionProps } from "@/components/config/constants";

const SECTION_BODIES: Record<SectionId, (props: SectionProps) => ReactNode> = {
  essentials: EssentialsSection,
  folders: FoldersSection,
  duplicates: DuplicatesSection,
  rename: RenameSection,
  conversion: ConversionSection,
  filters: FiltersSection,
  rules: RulesSection,
  ai: AiSection,
  other: OtherSection,
};

export function ConfigPanel({
  disabled = false,
  onSaveConfig,
  sectionBodyKey = 0,
}: {
  disabled?: boolean;
  onSaveConfig?: (patch: Partial<Config>) => void;
  sectionBodyKey?: number;
}) {
  const { config, isLoading, error, updateConfig, fieldErrors } = useConfig();
  const saveConfig = onSaveConfig ?? updateConfig;
  const sectionMeta = useConfigSections();
  const defaults = useConfigDefaults();
  const [active, setActive] = useState<SectionId>("essentials");

  // Declared before the hooks/handlers that reference it. Previously this was a
  // `const` defined lower in the body, so the `activeSectionFields` memo below hit
  // it in the temporal dead zone during render ("Cannot access 'sectionFields'
  // before initialization") and the whole app failed to mount.
  const sectionFields = (id: string): string[] => sectionMeta.get(id)?.fields ?? [];

  // Accurate deviation detection against the backend's own defaults (falls back
  // to the local mirror only until the defaults query resolves).
  const changed = useMemo(
    () => (config && defaults ? changedKeys(config, defaults) : null),
    [config, defaults],
  );
  const diffEntries = useMemo(
    () => (config && defaults ? diffConfig(config, defaults) : []),
    [config, defaults],
  );
  // Per-section diff: only entries whose field belongs to the active section.
  // sectionMeta is stale=Infinity so section fields are effectively static;
  // recomputing when `active` changes is enough.
  const activeSectionFields = useMemo(
    () => new Set<string>(sectionFields(active)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active],
  );

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-5">
          <div className="animate-pulse space-y-3">
            {[...Array(5)].map((_, j) => (
              <div key={j} className="h-4 rounded bg-muted" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !config) {
    return (
      <Card>
        <CardContent className="py-6 text-center">
          <p className="text-sm text-muted-foreground">
            Settings unavailable — check the backend connection.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Reset that section's fields to the backend defaults (comprehensive — covers
  // every field, not just the local mirror's subset). Falls back to the local
  // mirror until the defaults query resolves.
  const resetSection = (section: SectionId) => {
    if (defaults) {
      const patch: Partial<Config> = {};
      for (const f of sectionFields(section)) {
        if (f in defaults) patch[f as keyof Config] = defaults[f as keyof Config] as never;
      }
      saveConfig(patch);
    } else {
      saveConfig(SECTION_DEFAULTS[section]);
    }
  };

  const resetAll = () => {
    if (defaults) {
      saveConfig(defaults);
    } else {
      const combined = Object.values(SECTION_DEFAULTS).reduce(
        (acc, s) => ({ ...acc, ...s }),
        {} as Partial<Config>,
      );
      saveConfig(combined);
    }
  };

  const railItems = SECTION_META.map((m) => ({
    id: m.id,
    label: sectionMeta.get(m.id)?.label ?? m.label,
    icon: m.icon,
    group: m.group,
    active: changed
      ? sectionFields(m.id).some((f) => changed.has(f))
      : isSectionDirty(config, m.id),
    // A section is in error when any field it owns has a server validation
    // error — the rail flags it so the user can find the problem from any pane.
    error: sectionFields(m.id).some((f) => fieldErrors.has(f)),
  }));

  const activeMeta = SECTION_META.find((m) => m.id === active) ?? SECTION_META[0];
  const activeLabel = sectionMeta.get(active)?.label ?? activeMeta.label;
  const activeDescription = sectionMeta.get(active)?.description ?? activeMeta.description;
  const Body = SECTION_BODIES[active];

  return (
    <Card>
      <CardContent className="p-0 lg:flex lg:items-stretch">
        <div className="border-b border-border p-2 lg:w-56 lg:shrink-0 lg:border-b-0 lg:border-r">
          <SettingsRail items={railItems} selected={active} onSelect={setActive} />
          {!disabled && !defaults && (
            <div className="mt-2 hidden px-3 lg:block">
              <button
                type="button"
                onClick={resetAll}
                className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
              >
                Reset all to defaults
              </button>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 p-4 lg:p-5">
          {disabled && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
              <FiLock className="h-3 w-3 shrink-0" />
              Settings are locked while a computation is in progress.
            </div>
          )}
          {/* Per-section "what differs from defaults" summary. Only shown once
              the backend defaults have loaded to avoid a misleading flash. */}
          {defaults && (
            <ChangedFromDefaults
              entries={diffEntries.filter((e) => activeSectionFields.has(e.key as string))}
              onResetAll={() => resetSection(active)}
              resetLabel="Reset section"
              disabled={disabled}
            />
          )}
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <span className="text-muted-foreground">{activeMeta.icon}</span>
                {activeLabel}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{activeDescription}</p>
            </div>
            {!disabled && <ResetButton onClick={() => resetSection(active)} />}
          </div>

          {/* `inert` also blocks keyboard focus — pointer-events-none alone left
              the "locked" inputs tab-reachable. (Attribute-spread form: React 18
              has no typed `inert` prop yet.) */}
          <div
            className={cn(disabled && "pointer-events-none select-none opacity-60")}
            {...(disabled ? ({ inert: "" } as Record<string, unknown>) : {})}
          >
            <div key={active} className={cn(!disabled && "step-enter")}>
              <div key={sectionBodyKey} className="space-y-4">
                <Body
                  config={config}
                  updateConfig={disabled ? () => {} : saveConfig}
                  fieldErrors={fieldErrors}
                />
              </div>
            </div>
          </div>

          {!disabled && !defaults && (
            <div className="mt-5 lg:hidden">
              <button
                type="button"
                onClick={resetAll}
                className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
              >
                Reset all to defaults
              </button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
