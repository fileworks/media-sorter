import { FormRow } from "@/components/ui/form-row";
import { Toggle } from "@/components/ui/toggle";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { PerceptualSlider } from "@/components/config/fields/PerceptualSlider";
import { HELP } from "@/components/config/help";
import type { SectionProps } from "@/components/config/constants";

export function DuplicatesSection({ config, updateConfig }: SectionProps) {
  const threshold = config.duplicate_perceptual_threshold ?? 95;
  return (
    <>
      <FormRow label="Detect duplicates" htmlFor="remove-duplicates" inline>
        <Toggle
          id="remove-duplicates"
          checked={config.remove_duplicates}
          onChange={(v) => updateConfig({ remove_duplicates: v })}
        />
      </FormRow>

      {config.remove_duplicates && (
        <div className="ml-2 space-y-3 border-l-2 border-border pl-3">
          <FormRow
            label="Exact match (SHA-256)"
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
            label="Perceptual match"
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
                <p className="text-xs font-medium text-foreground">Similarity threshold</p>
                <InfoTooltip content={HELP.duplicateThreshold} side="right" />
              </div>
              <PerceptualSlider
                value={threshold}
                onChange={(v) => updateConfig({ duplicate_perceptual_threshold: v })}
              />
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Duplicates are set aside in <code className="font-mono">_duplicates/</code> — never
            deleted, so every match is recoverable.
          </p>

          <FormRow
            label="Compare against destination"
            htmlFor="dedup-destination"
            help={HELP.dedupAgainstDestination}
            inline
          >
            <Toggle
              id="dedup-destination"
              checked={config.dedup_against_destination ?? false}
              onChange={(v) => updateConfig({ dedup_against_destination: v })}
            />
          </FormRow>
        </div>
      )}
    </>
  );
}
