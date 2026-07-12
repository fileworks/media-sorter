import { FormRow } from "@/components/ui/form-row";
import { Toggle } from "@/components/ui/toggle";
import { RenameBuilder } from "@/components/config/fields/RenameBuilder";
import { HELP } from "@/components/config/help";
import type { SectionProps } from "@/components/config/constants";

export function RenameSection({ config, updateConfig }: SectionProps) {
  return (
    <>
      <FormRow label="Rename files" htmlFor="rename-files" help={HELP.renameFiles} inline>
        <Toggle
          id="rename-files"
          checked={config.rename}
          onChange={(v) => updateConfig({ rename: v })}
        />
      </FormRow>

      {config.rename && (
        <div className="rounded-md border border-border bg-muted/20 p-3">
          <FormRow label="Pattern" htmlFor="rename-pattern">
            <RenameBuilder
              configPattern={config.rename_pattern}
              onCommit={(v) => updateConfig({ rename_pattern: v })}
            />
          </FormRow>
        </div>
      )}
    </>
  );
}
