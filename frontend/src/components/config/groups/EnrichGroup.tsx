/** Enrich — optional conversion, tagging, and repair work. */

import { clampConfidence, clampMargin, clampMaxTags } from "@/components/config/constants";
import type { SectionProps } from "@/components/config/constants";
import { AiCapabilityChip, ModelTierSelect } from "@/components/config/fields/AiEngine";
import { AiTagsInput } from "@/components/config/fields/AiTagsInput";
import { CategorizeConfidenceSlider } from "@/components/config/fields/CategorizeConfidenceSlider";
import { CategoryTagsInput } from "@/components/config/fields/CategoryTagsInput";
import { RuleBuilderInline } from "@/components/RuleBuilder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Disclosure } from "@/components/ui/disclosure";
import { Segmented, SettingGroup, SettingRow, SubSetting } from "@/components/ui/setting-row";
import { Toggle } from "@/components/ui/toggle";
import { useAiModels } from "@/hooks/useAiModels";
import { useHardware } from "@/hooks/useHardware";
import { useI18n } from "@/i18n/I18nContext";
import { isLocalAiOff, machineTooWeak } from "@/lib/aiTier";
import type { Config } from "@/types/api";

export function EnrichGroup({ config, updateConfig, onReset }: SectionProps) {
  const { t } = useI18n();
  const { hardware, error: hardwareError, refetch: retryHardware } = useHardware();
  const { inventory } = useAiModels();

  const tooWeak = machineTooWeak(hardware);
  const localOff = hardware ? isLocalAiOff(config, hardware) : false;
  const requiredModel = inventory?.packs.find(
    (pack) => pack.pack_id === inventory.required_pack_id,
  );
  const modelMissing = !localOff && requiredModel?.state !== "ready";

  const categorizeBlocked = config.preserve_subfolders || localOff || modelMissing;
  const categorizeReason = config.preserve_subfolders
    ? t("config.folder.disablePreserve")
    : localOff
      ? tooWeak
        ? t("config.folder.machineWeak")
        : t("config.folder.enableLocal")
      : modelMissing
        ? t("config.folder.installLocal")
        : undefined;

  const labels = config.ai_tagging_labels;
  const lossyFormat = config.image_format === "jpeg" || config.image_format === "webp";

  return (
    <SettingGroup
      id="group-enrich"
      title={t("config.group.enrich.label")}
      subtitle={t("config.group.enrich.description")}
      onReset={onReset}
      resetLabel={t("config.rail.resetGroup")}
    >
      <SettingRow
        id="setting-conversion"
        field={["convert_images", "image_format"]}
        label={t("config.conversion.images")}
        description={t("config.conversion.imagesHelp")}
        htmlFor="convert-images"
        sub={
          config.convert_images && lossyFormat ? (
            <SubSetting
              field="image_quality"
              label={t("config.conversion.quality")}
              htmlFor="image-quality"
            >
              <input
                id="image-quality"
                type="range"
                min={60}
                max={100}
                value={config.image_quality}
                onChange={(event) => updateConfig({ image_quality: Number(event.target.value) })}
                className="w-32"
              />
              <span className="w-7 text-right font-mono text-xs text-foreground">
                {config.image_quality}
              </span>
            </SubSetting>
          ) : undefined
        }
      >
        <Toggle
          id="convert-images"
          label={t("config.conversion.images")}
          checked={config.convert_images}
          onChange={(value) => updateConfig({ convert_images: value })}
        />
        <Select
          aria-label={t("config.conversion.imageFormat")}
          value={config.image_format}
          disabled={!config.convert_images}
          onValueChange={(value) => updateConfig({ image_format: value as Config["image_format"] })}
          className="w-28"
        >
          <SelectItem value="jpeg">JPEG</SelectItem>
          <SelectItem value="png">PNG</SelectItem>
          <SelectItem value="webp">WebP</SelectItem>
          <SelectItem value="tiff">TIFF</SelectItem>
        </Select>
      </SettingRow>

      <SettingRow
        field={["convert_videos", "video_format"]}
        label={t("config.conversion.videos")}
        description={t("config.conversion.videosHelp")}
        htmlFor="convert-videos"
        sub={
          config.convert_videos ? (
            <SubSetting field="video_quality" label={t("config.conversion.videoQuality")}>
              <Segmented
                name="video-quality"
                label={t("config.conversion.videoQuality")}
                value={config.video_quality}
                options={[
                  { value: "low", label: t("config.quality.low") },
                  { value: "medium", label: t("config.quality.medium") },
                  { value: "high", label: t("config.quality.high") },
                ]}
                onChange={(value) => updateConfig({ video_quality: value })}
              />
            </SubSetting>
          ) : undefined
        }
      >
        <Toggle
          id="convert-videos"
          label={t("config.conversion.videos")}
          checked={config.convert_videos}
          onChange={(value) => updateConfig({ convert_videos: value })}
        />
        <Select
          aria-label={t("config.conversion.videoFormat")}
          value={config.video_format}
          disabled={!config.convert_videos}
          onValueChange={(value) => updateConfig({ video_format: value as Config["video_format"] })}
          className="w-28"
        >
          <SelectItem value="mp4">MP4</SelectItem>
          <SelectItem value="mkv">MKV</SelectItem>
          <SelectItem value="mov">MOV</SelectItem>
          <SelectItem value="webm">WebM</SelectItem>
          <SelectItem value="avi">AVI</SelectItem>
        </Select>
      </SettingRow>

      <div id="setting-ai" data-local-ai-setup className="space-y-3 border-b border-border p-4">
        {hardware ? (
          <>
            <AiCapabilityChip hardware={hardware} config={config} />
            <ModelTierSelect hardware={hardware} config={config} updateConfig={updateConfig} />
          </>
        ) : hardwareError ? (
          <div role="alert" className="space-y-2 text-xs text-error">
            <p>{t("config.ai.hardwareUnavailable")}</p>
            <Button variant="outline" size="sm" onClick={() => void retryHardware()}>
              {t("state.retry")}
            </Button>
          </div>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            {t("config.ai.hardwareChecking")}
          </p>
        )}
      </div>

      <SettingRow
        field="ai_tagging_enabled"
        label={t("config.ai.enabled")}
        description={t("config.ai.explanation")}
        htmlFor="ai-enabled"
        badge={
          // Tagging runs on this machine and nowhere else, so the badge is
          // unconditional rather than a property of a chosen provider.
          <span className="rounded-full bg-tint-success px-2 py-0.5 text-3xs font-semibold text-success">
            {t("config.ai.offlineBadge")}
          </span>
        }
      >
        <Toggle
          id="ai-enabled"
          label={t("config.ai.enabled")}
          checked={config.ai_tagging_enabled}
          onChange={(value) => updateConfig({ ai_tagging_enabled: value })}
        />
      </SettingRow>

      {config.ai_tagging_enabled && (
        <>
          <SettingRow
            field="embed_tags_in_files"
            label={t("config.ai.embed")}
            description={t("config.ai.embedHelp")}
            htmlFor="ai-embed"
          >
            <Select
              id="ai-embed"
              value={config.embed_tags_in_files ? "embedded" : "sidecar"}
              onValueChange={(value) => updateConfig({ embed_tags_in_files: value === "embedded" })}
              className="w-48"
            >
              <SelectItem value="sidecar">{t("config.ai.writeSidecar")}</SelectItem>
              <SelectItem value="embedded">{t("config.ai.writeEmbedded")}</SelectItem>
            </Select>
          </SettingRow>

          <Disclosure summary={t("config.ai.advanced")}>
            {!localOff && (
              <SettingRow
                field={["ai_tagging_labels", "ai_tagging_labels_provenance"]}
                label={t("config.ai.labels")}
                description={t("config.ai.labelsHelp")}
                stacked
                last
              >
                <AiTagsInput
                  labels={labels}
                  onCommit={(next) =>
                    updateConfig({
                      ai_tagging_labels: next,
                      ai_tagging_labels_provenance: "custom",
                    })
                  }
                />
                {config.ai_tagging_labels_provenance === "custom" && (
                  <button
                    type="button"
                    onClick={() => updateConfig({ ai_tagging_labels_provenance: "bundled" })}
                    className="mt-2 text-xs text-primary underline underline-offset-2"
                  >
                    {t("config.vocabulary.restore")}
                  </button>
                )}
              </SettingRow>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <SettingRow
                field="ai_tagging_max_tags"
                label={t("config.ai.maxTags")}
                htmlFor="ai-max-tags"
                stacked
                last
              >
                <Input
                  id="ai-max-tags"
                  type="number"
                  min={1}
                  max={50}
                  value={config.ai_tagging_max_tags}
                  onChange={(event) =>
                    updateConfig({
                      ai_tagging_max_tags: clampMaxTags(
                        event.target.value,
                        config.ai_tagging_max_tags,
                      ),
                    })
                  }
                />
              </SettingRow>
              <SettingRow
                field="ai_tagging_confidence_threshold"
                label={t("config.ai.confidence")}
                htmlFor="ai-confidence"
                stacked
                last
              >
                <Input
                  id="ai-confidence"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={config.ai_tagging_confidence_threshold}
                  onChange={(event) =>
                    updateConfig({
                      ai_tagging_confidence_threshold: clampConfidence(
                        event.target.value,
                        config.ai_tagging_confidence_threshold,
                      ),
                    })
                  }
                />
              </SettingRow>
            </div>
          </Disclosure>
        </>
      )}

      <SettingRow
        field="categorize_enabled"
        label={t("config.folder.categorize")}
        description={t("config.folder.categorizeHelp")}
        htmlFor="categorize-enabled"
        disabled={categorizeBlocked}
        disabledReason={categorizeReason}
      >
        <Toggle
          id="categorize-enabled"
          label={t("config.folder.categorize")}
          checked={config.categorize_enabled}
          disabled={categorizeBlocked}
          onChange={(value) => updateConfig({ categorize_enabled: value })}
        />
      </SettingRow>

      {config.categorize_enabled && !categorizeBlocked && (
        <Disclosure summary={t("config.folder.advanced")}>
          <SettingRow
            field={["categorize_categories", "categorize_categories_provenance"]}
            label={t("config.folder.categories")}
            description={t("config.folder.categoriesHelp")}
            stacked
            last
          >
            <CategoryTagsInput
              categories={config.categorize_categories}
              onChange={(next) =>
                updateConfig({
                  categorize_categories: next,
                  categorize_categories_provenance: "custom",
                })
              }
            />
            {config.categorize_categories_provenance === "custom" && (
              <button
                type="button"
                onClick={() => updateConfig({ categorize_categories_provenance: "bundled" })}
                className="mt-2 text-xs text-primary underline underline-offset-2"
              >
                {t("config.vocabulary.restore")}
              </button>
            )}
          </SettingRow>
          <SettingRow
            field="categorize_confidence_threshold"
            label={t("config.folder.confident")}
            stacked
            last
          >
            <CategorizeConfidenceSlider
              value={config.categorize_confidence_threshold}
              onChange={(value) => updateConfig({ categorize_confidence_threshold: value })}
            />
          </SettingRow>
          <SettingRow
            field="categorize_min_margin"
            label={t("config.folder.margin")}
            htmlFor="categorize-margin"
            stacked
            last
          >
            <Input
              id="categorize-margin"
              type="number"
              min={0}
              max={0.5}
              step={0.05}
              value={config.categorize_min_margin}
              onChange={(event) =>
                updateConfig({
                  categorize_min_margin: clampMargin(
                    event.target.value,
                    config.categorize_min_margin,
                  ),
                })
              }
              className="max-w-[8rem]"
            />
          </SettingRow>
        </Disclosure>
      )}

      <SettingRow
        id="setting-rules"
        field={["rules_enabled", "rule_set"]}
        label={t("rules.enable")}
        description={t("config.rules.help")}
        htmlFor="rules-enabled"
      >
        <Toggle
          id="rules-enabled"
          label={t("rules.enable")}
          checked={config.rules_enabled}
          onChange={(value) => updateConfig({ rules_enabled: value })}
        />
      </SettingRow>

      {config.rules_enabled && (
        <Disclosure summary={t("config.rules.edit")}>
          <RuleBuilderInline config={config} updateConfig={updateConfig} />
        </Disclosure>
      )}

      <SettingRow
        id="setting-maintenance"
        field="override_metadata"
        label={t("config.other.fixDates")}
        description={t("config.other.fixDatesHelp")}
        htmlFor="override-metadata"
      >
        <Toggle
          id="override-metadata"
          label={t("config.other.fixDates")}
          checked={config.override_metadata}
          onChange={(value) => updateConfig({ override_metadata: value })}
        />
      </SettingRow>

      <SettingRow
        field="repair_enabled"
        label={t("config.other.repair")}
        description={t("config.other.repairHelp")}
        htmlFor="repair-enabled"
      >
        <Toggle
          id="repair-enabled"
          label={t("config.other.repair")}
          checked={config.repair_enabled}
          onChange={(value) => updateConfig({ repair_enabled: value })}
        />
      </SettingRow>

      <SettingRow
        field="index_workers"
        label={t("config.indexWorkers.label")}
        description={t("config.indexWorkers.help")}
        htmlFor="index-workers"
      >
        <div className="flex items-center gap-2">
          <Input
            id="index-workers"
            type="number"
            min={0}
            max={32}
            // 0 and empty both mean "ask the machine", which is what the
            // placeholder says. Storing null rather than a number is what keeps
            // the setting automatic on a machine with a different core count.
            value={config.index_workers ?? ""}
            placeholder={t("config.indexWorkers.auto")}
            onChange={(event) => {
              const raw = Number(event.target.value);
              updateConfig({
                index_workers:
                  event.target.value === "" || !Number.isFinite(raw) || raw <= 0
                    ? null
                    : Math.min(32, Math.trunc(raw)),
              });
            }}
            className="w-28"
          />
          {config.index_workers === null && (
            <span className="text-xs text-faint">{t("config.indexWorkers.auto")}</span>
          )}
        </div>
      </SettingRow>

      <SettingRow
        field="thumbnail_cache_enabled"
        label={t("config.thumbnailCache.label")}
        description={t("config.thumbnailCache.help")}
        htmlFor="thumbnail-cache-enabled"
        last
        sub={
          config.thumbnail_cache_enabled ? (
            <SubSetting
              field="thumbnail_cache_budget_bytes"
              label={t("config.thumbnailCache.budget")}
              description={t("config.thumbnailCache.budgetHelp")}
              htmlFor="thumbnail-cache-budget"
            >
              <Input
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
                className="w-28"
              />
              <span className="text-xs text-faint">{t("config.unit.mb")}</span>
            </SubSetting>
          ) : undefined
        }
      >
        <Toggle
          id="thumbnail-cache-enabled"
          label={t("config.thumbnailCache.label")}
          checked={config.thumbnail_cache_enabled}
          onChange={(value) => updateConfig({ thumbnail_cache_enabled: value })}
        />
      </SettingRow>
    </SettingGroup>
  );
}
