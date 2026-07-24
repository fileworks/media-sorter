import { FormRow } from "@/components/ui/form-row";
import { Toggle } from "@/components/ui/toggle";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { PerceptualSlider } from "@/components/config/fields/PerceptualSlider";
import { HELP } from "@/components/config/help";
import type { SectionProps } from "@/components/config/constants";
import { useI18n } from "@/i18n/I18nContext";

export function DuplicatesSection({ config, updateConfig }: SectionProps) {
  const { t } = useI18n();
  const threshold = config.duplicate_perceptual_threshold ?? 95;
  return (
    <>
      <FormRow label={t("config.duplicates.detect")} htmlFor="remove-duplicates" inline>
        <Toggle
          id="remove-duplicates"
          checked={config.remove_duplicates}
          onChange={(v) => updateConfig({ remove_duplicates: v })}
        />
      </FormRow>

      {config.remove_duplicates && (
        <div className="ml-2 space-y-3 border-l-2 border-border pl-3">
          <FormRow
            label={t("config.duplicates.exact")}
            htmlFor="dup-exact"
            help={HELP.duplicateExact}
            inline
          >
            <Toggle
              id="dup-exact"
              checked={config.duplicate_exact_enabled ?? true}
              onChange={(v) => updateConfig({ duplicate_exact_enabled: v })}
            />
          </FormRow>

          <FormRow
            label={t("config.duplicates.perceptual")}
            htmlFor="dup-perceptual"
            help={HELP.duplicatePerceptual}
            inline
          >
            <Toggle
              id="dup-perceptual"
              checked={config.duplicate_perceptual_enabled ?? true}
              onChange={(v) => updateConfig({ duplicate_perceptual_enabled: v })}
            />
          </FormRow>

          {(config.duplicate_perceptual_enabled ?? true) && (
            <div className="pl-2">
              <div className="mb-1 flex items-center gap-1.5">
                <p className="text-xs font-medium text-foreground">
                  {t("config.duplicates.threshold")}
                </p>
                <InfoTooltip content={HELP.duplicateThreshold} side="right" />
              </div>
              <PerceptualSlider
                value={threshold}
                onChange={(v) => updateConfig({ duplicate_perceptual_threshold: v })}
              />
            </div>
          )}

          <p className="text-xs text-muted-foreground">{t("config.duplicates.recovery")}</p>
          <p className="text-xs text-muted-foreground">
            {t("config.duplicates.destinationAlways")}
          </p>
        </div>
      )}
    </>
  );
}
