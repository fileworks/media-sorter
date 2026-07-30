import { FormRow } from "@/components/ui/form-row";
import { Toggle } from "@/components/ui/toggle";
import { HELP } from "@/components/config/help";
import type { SectionProps } from "@/components/config/constants";
import { useI18n } from "@/i18n/I18nContext";

export function OtherSection({ config, updateConfig }: SectionProps) {
  const { t } = useI18n();
  return (
    <>
      <FormRow
        label={t("config.other.fixDates")}
        htmlFor="override-metadata"
        help={HELP.overrideMetadata}
        inline
      >
        <Toggle
          id="override-metadata"
          checked={config.override_metadata}
          onChange={(v) => updateConfig({ override_metadata: v })}
        />
      </FormRow>
      <FormRow label={t("config.other.repair")} htmlFor="repair-enabled" help={HELP.repair} inline>
        <Toggle
          id="repair-enabled"
          checked={config.repair_enabled ?? true}
          onChange={(v) => updateConfig({ repair_enabled: v })}
        />
      </FormRow>
      <FormRow
        label={t("config.thumbnailCache.label")}
        htmlFor="thumbnail-cache-enabled"
        help={t("config.thumbnailCache.help")}
        inline
      >
        <Toggle
          id="thumbnail-cache-enabled"
          checked={config.thumbnail_cache_enabled}
          onChange={(v) => updateConfig({ thumbnail_cache_enabled: v })}
        />
      </FormRow>
      {config.thumbnail_cache_enabled && (
        <FormRow
          label={t("config.thumbnailCache.budget")}
          htmlFor="thumbnail-cache-budget"
          help={t("config.thumbnailCache.budgetHelp")}
        >
          <input
            id="thumbnail-cache-budget"
            type="number"
            min={16}
            max={16384}
            step={16}
            value={Math.round(config.thumbnail_cache_budget_bytes / (1024 * 1024))}
            onChange={(event) =>
              updateConfig({
                thumbnail_cache_budget_bytes:
                  Math.max(16, Number(event.target.value) || 16) * 1024 * 1024,
              })
            }
            className="w-28 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
        </FormRow>
      )}
    </>
  );
}
