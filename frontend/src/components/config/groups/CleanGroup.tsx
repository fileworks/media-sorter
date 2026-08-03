/**
 * 02 Clean — duplicates and junk. Nothing here ever deletes anything.
 *
 * Every setting in this group sets files *aside*, into a review folder inside
 * the destination, and the group's subtitle says so once rather than each row
 * repeating the reassurance. The set-aside locations are shown as read-only
 * values because knowing where the losing copies went is the entire reason the
 * promise is believable.
 */

import type { SectionProps } from "@/components/config/constants";
import { MAX_FILE_SIZE_INPUT, clampFileSize } from "@/components/config/constants";
import { ExcludePatternTags } from "@/components/config/fields/ExcludePatternTags";
import { PerceptualSlider } from "@/components/config/fields/PerceptualSlider";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { MonoValue, Segmented, SettingGroup, SettingRow } from "@/components/ui/setting-row";
import { Toggle } from "@/components/ui/toggle";
import { useI18n } from "@/i18n/I18nContext";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/types/api";

export function CleanGroup({ config, updateConfig }: SectionProps) {
  const { t } = useI18n();

  const excludePatterns = config.exclude_patterns ?? [];
  const junkPatterns = config.junk_filename_patterns ?? [];

  // Exact-only versus exact-plus-near is one decision to a user even though it
  // is two flags underneath; presenting it as two toggles invites the
  // meaningless "neither" state.
  const detection = config.duplicate_perceptual_enabled ? "both" : "exact";

  return (
    <SettingGroup
      id="group-clean"
      ordinal="02"
      title={t("config.group.clean.label")}
      subtitle={t("config.group.clean.description")}
    >
      <SettingRow
        id="setting-duplicates"
        label={t("config.duplicates.detect")}
        description={t("config.duplicates.detectHelp")}
        htmlFor="remove-duplicates"
      >
        <Toggle
          id="remove-duplicates"
          label={t("config.duplicates.detect")}
          checked={config.remove_duplicates}
          onChange={(value) => updateConfig({ remove_duplicates: value })}
        />
      </SettingRow>

      {config.remove_duplicates && (
        <>
          <SettingRow
            label={t("config.duplicates.matching")}
            description={t("config.duplicates.matchingHelp")}
          >
            <Segmented
              name="duplicate-detection"
              label={t("config.duplicates.matching")}
              value={detection}
              options={[
                { value: "exact", label: t("config.duplicates.exactOnly") },
                { value: "both", label: t("config.duplicates.exactAndNear") },
              ]}
              onChange={(value) =>
                updateConfig({
                  duplicate_exact_enabled: true,
                  duplicate_perceptual_enabled: value === "both",
                })
              }
            />
          </SettingRow>

          {config.duplicate_perceptual_enabled && (
            <SettingRow
              label={t("config.duplicates.threshold")}
              description={t("config.duplicates.thresholdHelp")}
            >
              <PerceptualSlider
                value={config.duplicate_perceptual_threshold ?? 95}
                onChange={(value) => updateConfig({ duplicate_perceptual_threshold: value })}
              />
            </SettingRow>
          )}

          <SettingRow
            label={t("config.duplicates.keepRule")}
            description={t("config.duplicates.keepRuleHelp")}
            htmlFor="keeper-policy"
          >
            <Select
              id="keeper-policy"
              value={config.duplicate_keeper_policy}
              onValueChange={(value) =>
                updateConfig({ duplicate_keeper_policy: value as KeeperPolicyId })
              }
              className="w-48"
            >
              {SELECTABLE_KEEPER_POLICIES.map((policy) => (
                <SelectItem key={policy} value={policy}>
                  {t(`config.keeper.${policy}`)}
                </SelectItem>
              ))}
            </Select>
          </SettingRow>

          <SettingRow
            label={t("config.duplicates.setAside")}
            description={t("config.duplicates.setAsideHelp")}
          >
            <MonoValue>_duplicates/</MonoValue>
          </SettingRow>
        </>
      )}

      <SettingRow
        id="setting-junk"
        label={t("config.filters.junk")}
        description={t("config.filters.junkHelp")}
        htmlFor="junk-filter"
      >
        <Toggle
          id="junk-filter"
          label={t("config.filters.junk")}
          checked={config.junk_filter_enabled ?? false}
          onChange={(value) => updateConfig({ junk_filter_enabled: value })}
        />
      </SettingRow>

      {config.junk_filter_enabled && (
        <>
          <SettingRow
            label={t("config.filters.junkSize")}
            description={t("config.filters.junkSizeHelp")}
            htmlFor="junk-min-size"
          >
            <Input
              id="junk-min-size"
              type="number"
              min={0}
              max={MAX_FILE_SIZE_INPUT}
              value={config.junk_min_file_size_kb ?? 8}
              onChange={(event) =>
                updateConfig({ junk_min_file_size_kb: clampFileSize(event.target.value) ?? 0 })
              }
              className="w-28"
            />
            <span className="text-xs text-faint">{t("config.unit.kb")}</span>
          </SettingRow>

          <SettingRow
            label={t("config.filters.resolution")}
            description={t("config.filters.resolutionHelp")}
            htmlFor="junk-min-dimension"
          >
            <Input
              id="junk-min-dimension"
              type="number"
              min={0}
              max={MAX_FILE_SIZE_INPUT}
              value={config.junk_min_image_dimension ?? 200}
              onChange={(event) =>
                updateConfig({
                  junk_min_image_dimension: clampFileSize(event.target.value) ?? 0,
                })
              }
              className="w-28"
            />
            <span className="text-xs text-faint">{t("config.unit.px")}</span>
          </SettingRow>

          <SettingRow
            stacked
            label={t("config.filters.junkPatterns")}
            description={t("config.filters.junkPatternsHelp")}
          >
            <ExcludePatternTags
              patterns={junkPatterns}
              onAdd={(pattern) =>
                !junkPatterns.includes(pattern) &&
                updateConfig({ junk_filename_patterns: [...junkPatterns, pattern] })
              }
              onRemove={(pattern) =>
                updateConfig({
                  junk_filename_patterns: junkPatterns.filter((p) => p !== pattern),
                })
              }
            />
          </SettingRow>

          <SettingRow
            label={t("config.filters.junkLocation")}
            description={t("config.filters.junkLocationHelp")}
          >
            <MonoValue>_junk/</MonoValue>
          </SettingRow>
        </>
      )}

      <SettingRow
        label={t("config.bursts.detect")}
        description={t("config.bursts.detectHelp")}
        htmlFor="detect-bursts"
      >
        <Toggle
          id="detect-bursts"
          label={t("config.bursts.detect")}
          checked={config.burst_detection_enabled}
          onChange={(value) => updateConfig({ burst_detection_enabled: value })}
        />
      </SettingRow>

      {config.burst_detection_enabled && (
        <SettingRow label={t("config.bursts.tuning")} description={t("config.bursts.reviewFirst")}>
          <Input
            type="number"
            min={0.1}
            max={30}
            step={0.1}
            aria-label={t("config.bursts.window")}
            value={config.burst_time_window_seconds}
            onChange={(event) =>
              updateConfig({ burst_time_window_seconds: Number(event.target.value) })
            }
            className="w-24"
          />
          <span className="text-xs text-faint">{t("config.unit.seconds")}</span>
          <Input
            type="number"
            min={0}
            max={16}
            aria-label={t("config.bursts.distance")}
            value={config.burst_perceptual_distance}
            onChange={(event) =>
              updateConfig({ burst_perceptual_distance: Number(event.target.value) })
            }
            className="w-24"
          />
          <span className="text-xs text-faint">{t("config.unit.distance")}</span>
        </SettingRow>
      )}

      <SettingRow
        id="setting-scan"
        label={t("config.filters.recursive")}
        description={t("config.filters.recursiveHelp")}
        htmlFor="recursive-scan"
      >
        <Toggle
          id="recursive-scan"
          label={t("config.filters.recursive")}
          checked={config.recursive_scan}
          onChange={(value) => updateConfig({ recursive_scan: value })}
        />
      </SettingRow>

      <SettingRow
        label={t("config.filters.sizeRange")}
        description={t("config.filters.sizeRangeHelp")}
      >
        <Input
          type="number"
          min={0}
          max={MAX_FILE_SIZE_INPUT}
          aria-label={t("config.filters.minSize")}
          placeholder={t("config.filters.noMinimum")}
          value={config.min_file_size_kb ?? ""}
          onChange={(event) =>
            updateConfig({ min_file_size_kb: clampFileSize(event.target.value) })
          }
          className="w-36"
        />
        <span className="text-xs text-faint">{t("config.unit.kb")}</span>
        <span className="text-xs text-faint">—</span>
        <Input
          type="number"
          min={0}
          max={MAX_FILE_SIZE_INPUT}
          aria-label={t("config.filters.maxSize")}
          placeholder={t("config.filters.noMaximum")}
          value={config.max_file_size_mb ?? ""}
          onChange={(event) =>
            updateConfig({ max_file_size_mb: clampFileSize(event.target.value) })
          }
          className="w-36"
        />
        <span className="text-xs text-faint">{t("config.unit.mb")}</span>
      </SettingRow>

      <SettingRow
        stacked
        label={t("config.filters.exclude")}
        description={t("config.filters.excludeHelp")}
        last
      >
        <ExcludePatternTags
          patterns={excludePatterns}
          onAdd={(pattern) =>
            !excludePatterns.includes(pattern) &&
            updateConfig({ exclude_patterns: [...excludePatterns, pattern] })
          }
          onRemove={(pattern) =>
            updateConfig({ exclude_patterns: excludePatterns.filter((p) => p !== pattern) })
          }
        />
      </SettingRow>
    </SettingGroup>
  );
}
