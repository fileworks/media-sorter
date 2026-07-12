import { FormRow } from "@/components/ui/form-row";
import { Toggle } from "@/components/ui/toggle";
import { HELP } from "@/components/config/help";
import type { SectionProps } from "@/components/config/constants";

export function OtherSection({ config, updateConfig }: SectionProps) {
  return (
    <>
      <FormRow
        label="Fix dates in metadata"
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
      <FormRow label="Repair corrupted files" htmlFor="repair-enabled" help={HELP.repair} inline>
        <Toggle
          id="repair-enabled"
          checked={config.repair_enabled ?? true}
          onChange={(v) => updateConfig({ repair_enabled: v })}
        />
      </FormRow>
    </>
  );
}
