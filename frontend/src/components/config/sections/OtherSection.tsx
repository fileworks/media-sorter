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
    </>
  );
}
