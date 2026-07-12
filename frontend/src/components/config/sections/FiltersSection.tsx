import { FormRow } from "@/components/ui/form-row";
import { Toggle } from "@/components/ui/toggle";
import { Input } from "@/components/ui/input";
import { ExcludePatternTags } from "@/components/config/fields/ExcludePatternTags";
import { HELP } from "@/components/config/help";
import { clampFileSize, MAX_FILE_SIZE_INPUT } from "@/components/config/constants";
import type { SectionProps } from "@/components/config/constants";

export function FiltersSection({ config, updateConfig }: SectionProps) {
  const excludePatterns = config.exclude_patterns ?? [];
  const addExcludePattern = (pattern: string) => {
    if (!excludePatterns.includes(pattern)) {
      updateConfig({ exclude_patterns: [...excludePatterns, pattern] });
    }
  };
  const removeExcludePattern = (pattern: string) => {
    updateConfig({ exclude_patterns: excludePatterns.filter((p) => p !== pattern) });
  };

  const junkPatterns = config.junk_filename_patterns ?? [];
  const addJunkPattern = (pattern: string) => {
    if (!junkPatterns.includes(pattern)) {
      updateConfig({ junk_filename_patterns: [...junkPatterns, pattern] });
    }
  };
  const removeJunkPattern = (pattern: string) => {
    updateConfig({ junk_filename_patterns: junkPatterns.filter((p) => p !== pattern) });
  };

  return (
    <>
      <FormRow label="Scan subfolders" htmlFor="recursive-scan" help={HELP.recursiveScan} inline>
        <Toggle
          id="recursive-scan"
          checked={config.recursive_scan}
          onChange={(v) => updateConfig({ recursive_scan: v })}
        />
      </FormRow>

      <div className="grid grid-cols-2 gap-3">
        <FormRow
          label="Min file size (KB)"
          htmlFor="min-size"
          help={HELP.minFileSize}
          helpSide="right"
        >
          <Input
            id="min-size"
            type="number"
            min={0}
            max={MAX_FILE_SIZE_INPUT}
            value={config.min_file_size_kb ?? ""}
            onChange={(e) => updateConfig({ min_file_size_kb: clampFileSize(e.target.value) })}
            placeholder="No minimum"
          />
        </FormRow>

        <FormRow
          label="Max file size (MB)"
          htmlFor="max-size"
          help={HELP.maxFileSize}
          helpSide="right"
        >
          <Input
            id="max-size"
            type="number"
            min={0}
            max={MAX_FILE_SIZE_INPUT}
            value={config.max_file_size_mb ?? ""}
            onChange={(e) => updateConfig({ max_file_size_mb: clampFileSize(e.target.value) })}
            placeholder="No maximum"
          />
        </FormRow>
      </div>

      <FormRow label="Exclude patterns" help={HELP.excludePatterns} helpSide="right">
        <ExcludePatternTags
          patterns={excludePatterns}
          onAdd={addExcludePattern}
          onRemove={removeExcludePattern}
        />
      </FormRow>

      <FormRow label="Junk / thumbnail filter" htmlFor="junk-filter" help={HELP.junkFilter} inline>
        <Toggle
          id="junk-filter"
          checked={config.junk_filter_enabled ?? false}
          onChange={(v) => updateConfig({ junk_filter_enabled: v })}
        />
      </FormRow>

      {(config.junk_filter_enabled ?? false) && (
        <div className="ml-2 space-y-3 border-l-2 border-border pl-3">
          <div className="grid grid-cols-2 gap-3">
            <FormRow
              label="Junk size floor (KB)"
              htmlFor="junk-min-size"
              help={HELP.junkMinSize}
              helpSide="right"
            >
              <Input
                id="junk-min-size"
                type="number"
                min={0}
                max={MAX_FILE_SIZE_INPUT}
                value={config.junk_min_file_size_kb ?? 8}
                onChange={(e) =>
                  updateConfig({ junk_min_file_size_kb: clampFileSize(e.target.value) ?? 0 })
                }
              />
            </FormRow>

            <FormRow
              label="Resolution floor (px)"
              htmlFor="junk-min-dimension"
              help={HELP.junkMinDimension}
              helpSide="right"
            >
              <Input
                id="junk-min-dimension"
                type="number"
                min={0}
                max={MAX_FILE_SIZE_INPUT}
                value={config.junk_min_image_dimension ?? 200}
                onChange={(e) =>
                  updateConfig({ junk_min_image_dimension: clampFileSize(e.target.value) ?? 0 })
                }
              />
            </FormRow>
          </div>

          <FormRow label="Junk name patterns" help={HELP.junkPatterns} helpSide="right">
            <ExcludePatternTags
              patterns={junkPatterns}
              onAdd={addJunkPattern}
              onRemove={removeJunkPattern}
            />
          </FormRow>
        </div>
      )}
    </>
  );
}
