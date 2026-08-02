/**
 * 03 Enrich — optional work done to files while they are being sorted.
 *
 * This is the only group whose settings rewrite bytes, so it is the only one
 * with a real cost to getting wrong. The headline rows stay short and the
 * consequential detail — cloud credentials, label vocabularies, thresholds —
 * sits behind a disclosure, which is the progressive-disclosure rule the design
 * asks for: a group at its defaults should be one line, not forty.
 */

import type { ReactNode } from "react";
import { FiChevronRight } from "react-icons/fi";

import {
  DEFAULT_AI_LABELS,
  clampConfidence,
  clampMargin,
  clampMaxTags,
} from "@/components/config/constants";
import type { SectionProps } from "@/components/config/constants";
import { AiCapabilityChip } from "@/components/config/fields/AiEngine";
import { AiModelManager } from "@/components/config/fields/AiModelManager";
import { AiTagsInput } from "@/components/config/fields/AiTagsInput";
import { CategorizeConfidenceSlider } from "@/components/config/fields/CategorizeConfidenceSlider";
import { CategoryTagsInput } from "@/components/config/fields/CategoryTagsInput";
import { RuleBuilderInline } from "@/components/RuleBuilder";
import { BlurCommitInput } from "@/components/ui/blur-commit-input";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Segmented, SettingGroup, SettingRow } from "@/components/ui/setting-row";
import { Toggle } from "@/components/ui/toggle";
import { useAiModels } from "@/hooks/useAiModels";
import { useHardware } from "@/hooks/useHardware";
import { useI18n } from "@/i18n/I18nContext";
import { TIER_LABEL, effectiveTier, isLocalAiOff, machineTooWeak } from "@/lib/aiTier";
import type { AiModelTier, Config } from "@/types/api";

/** A row's deeper settings, closed until somebody wants them. */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group border-b border-border">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-5 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <FiChevronRight
          className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
          aria-hidden
        />
        {summary}
      </summary>
      <div className="space-y-3.5 border-t border-border bg-muted/40 px-5 py-4">{children}</div>
    </details>
  );
}

/** One labelled field inside a disclosure, where the row grid does not apply. */
function Field({
  label,
  help,
  htmlFor,
  children,
}: {
  label: string;
  help?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const Tag = htmlFor ? "label" : "div";
  return (
    <div>
      <Tag
        {...(htmlFor ? { htmlFor } : {})}
        className="block text-xs font-semibold text-foreground"
      >
        {label}
      </Tag>
      {help && <p className="mb-1.5 mt-0.5 text-xs text-faint">{help}</p>}
      <div className={help ? "" : "mt-1.5"}>{children}</div>
    </div>
  );
}

const AI_TIERS: Exclude<AiModelTier, "auto" | "off">[] = ["lite", "standard", "max"];

export function EnrichGroup({ config, updateConfig }: SectionProps) {
  const { t } = useI18n();
  const { hardware } = useHardware();
  const { inventory } = useAiModels();

  const tooWeak = machineTooWeak(hardware);
  const localOff = hardware ? isLocalAiOff(config, hardware) : false;
  const resolvedTier = hardware ? effectiveTier(config, hardware) : "off";
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

  const labels = config.ai_tagging_labels ?? DEFAULT_AI_LABELS;
  const lossyFormat = config.image_format === "jpeg" || config.image_format === "webp";
  const isLocalProvider = config.ai_tagging_provider === "local";

  return (
    <SettingGroup
      id="group-enrich"
      ordinal="03"
      title={t("config.group.enrich.label")}
      subtitle={t("config.group.enrich.description")}
    >
      <SettingRow
        id="setting-conversion"
        label={t("config.conversion.images")}
        description={t("config.conversion.imagesHelp")}
        htmlFor="convert-images"
      >
        <Toggle
          id="convert-images"
          label={t("config.conversion.images")}
          checked={config.convert_images ?? false}
          onChange={(value) => updateConfig({ convert_images: value })}
        />
        <Select
          aria-label={t("config.conversion.imageFormat")}
          value={config.image_format ?? "jpeg"}
          disabled={!config.convert_images}
          onValueChange={(value) => updateConfig({ image_format: value as Config["image_format"] })}
          className="w-28"
        >
          <SelectItem value="jpeg">JPEG</SelectItem>
          <SelectItem value="png">PNG</SelectItem>
          <SelectItem value="webp">WebP</SelectItem>
          <SelectItem value="tiff">TIFF</SelectItem>
        </Select>
        {config.convert_images && lossyFormat && (
          <>
            <input
              type="range"
              min={60}
              max={100}
              value={config.image_quality}
              aria-label={t("config.conversion.quality")}
              onChange={(event) =>
                updateConfig({ image_quality: Number(event.target.value) })
              }
              className="w-32"
            />
            <span className="w-7 text-right font-mono text-xs text-foreground">
              {config.image_quality}
            </span>
          </>
        )}
      </SettingRow>

      <SettingRow
        label={t("config.conversion.videos")}
        description={t("config.conversion.videosHelp")}
        htmlFor="convert-videos"
      >
        <Toggle
          id="convert-videos"
          label={t("config.conversion.videos")}
          checked={config.convert_videos ?? false}
          onChange={(value) => updateConfig({ convert_videos: value })}
        />
        <Select
          aria-label={t("config.conversion.videoFormat")}
          value={config.video_format ?? "mp4"}
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
        {config.convert_videos && (
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
        )}
      </SettingRow>

      <SettingRow
        id="setting-ai"
        label={t("config.ai.enabled")}
        description={t("config.ai.explanation")}
        htmlFor="ai-enabled"
        badge={
          isLocalProvider ? (
            <span className="rounded-full bg-tint-success px-2 py-0.5 text-3xs font-semibold text-success">
              {t("config.ai.offlineBadge")}
            </span>
          ) : undefined
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
          {hardware && !tooWeak && isLocalProvider && (
            <div className="grid gap-2.5 border-b border-border px-5 py-3.5 sm:grid-cols-3">
              {AI_TIERS.map((tier) => {
                const active = (config.ai_model_tier ?? "auto") === tier;
                const recommended = hardware.recommended_tier === tier;
                return (
                  <label
                    key={tier}
                    className={`flex cursor-pointer flex-col gap-1 rounded-lg border px-3.5 py-2.5 transition-colors ${
                      active
                        ? "border-[1.5px] border-brand bg-tint-primary"
                        : "border-border hover:border-faint"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-xs font-semibold">
                      <input
                        type="radio"
                        name="ai-model-tier"
                        checked={active}
                        onChange={() => updateConfig({ ai_model_tier: tier })}
                        className="h-3.5 w-3.5"
                      />
                      <span className={active ? "text-primary" : "text-foreground"}>
                        {t(`config.ai.tierName.${tier}`, undefined, TIER_LABEL[tier])}
                      </span>
                      {recommended && (
                        <span className="text-3xs font-medium text-success">
                          {t("config.ai.tierRecommended")}
                        </span>
                      )}
                    </span>
                    <span className="pl-[1.4rem] text-xs text-faint">
                      {t(`config.ai.tierCost.${tier}`)}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <SettingRow
            label={t("config.ai.embed")}
            description={t("config.ai.embedHelp")}
            htmlFor="ai-embed"
          >
            <Select
              id="ai-embed"
              value={config.embed_tags_in_files ? "embedded" : "sidecar"}
              onValueChange={(value) =>
                updateConfig({ embed_tags_in_files: value === "embedded" })
              }
              className="w-48"
            >
              <SelectItem value="sidecar">{t("config.ai.writeSidecar")}</SelectItem>
              <SelectItem value="embedded">{t("config.ai.writeEmbedded")}</SelectItem>
            </Select>
          </SettingRow>

          <Disclosure summary={t("config.ai.advanced")}>
            {hardware && <AiCapabilityChip hardware={hardware} config={config} />}

            <Field label={t("config.ai.provider")} htmlFor="ai-provider">
              <Select
                id="ai-provider"
                value={config.ai_tagging_provider}
                onValueChange={(value) =>
                  updateConfig({ ai_tagging_provider: value as Config["ai_tagging_provider"] })
                }
                className="max-w-sm"
              >
                <SelectItem value="local">{t("config.ai.local")}</SelectItem>
                <SelectItem value="azure_vision">{t("config.ai.azure")}</SelectItem>
                <SelectItem value="imagga">{t("config.ai.imagga")}</SelectItem>
                <SelectItem value="google_cloud_vision">{t("config.ai.google")}</SelectItem>
              </Select>
            </Field>

            {config.ai_tagging_provider === "azure_vision" && (
              <>
                <Field label={t("config.ai.endpoint")} htmlFor="ai-azure-endpoint">
                  <BlurCommitInput
                    id="ai-azure-endpoint"
                    type="text"
                    value={config.ai_tagging_endpoint}
                    onCommit={(value) => updateConfig({ ai_tagging_endpoint: value })}
                    placeholder={t("config.ai.azureEndpointPlaceholder")}
                  />
                </Field>
                <Field label={t("config.ai.apiKey")} htmlFor="ai-azure-key">
                  <BlurCommitInput
                    id="ai-azure-key"
                    type="password"
                    value={config.ai_tagging_api_key}
                    onCommit={(value) => updateConfig({ ai_tagging_api_key: value })}
                    placeholder={t("config.ai.subscriptionKey")}
                  />
                </Field>
              </>
            )}

            {config.ai_tagging_provider === "imagga" && (
              <>
                <Field label={t("config.ai.apiKey")} htmlFor="ai-imagga-key">
                  <BlurCommitInput
                    id="ai-imagga-key"
                    type="password"
                    value={config.ai_tagging_api_key}
                    onCommit={(value) => updateConfig({ ai_tagging_api_key: value })}
                    placeholder={t("config.ai.imaggaKeyPlaceholder")}
                  />
                </Field>
                <Field label={t("config.ai.apiSecret")} htmlFor="ai-imagga-secret">
                  <BlurCommitInput
                    id="ai-imagga-secret"
                    type="password"
                    value={config.ai_tagging_api_secret}
                    onCommit={(value) => updateConfig({ ai_tagging_api_secret: value })}
                    placeholder={t("config.ai.imaggaSecretPlaceholder")}
                  />
                </Field>
              </>
            )}

            {config.ai_tagging_provider === "google_cloud_vision" && (
              <Field label={t("config.ai.apiKey")} htmlFor="ai-google-key">
                <BlurCommitInput
                  id="ai-google-key"
                  type="password"
                  value={config.ai_tagging_api_key}
                  onCommit={(value) => updateConfig({ ai_tagging_api_key: value })}
                  placeholder={t("config.ai.googleKeyPlaceholder")}
                />
              </Field>
            )}

            {isLocalProvider && !localOff && (
              <Field label={t("config.ai.labels")} help={t("config.ai.labelsHelp")}>
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
                    className="mt-1.5 text-xs text-primary underline underline-offset-2"
                  >
                    {t("config.vocabulary.restore")}
                  </button>
                )}
              </Field>
            )}

            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label={t("config.ai.maxTags")} htmlFor="ai-max-tags">
                <Input
                  id="ai-max-tags"
                  type="number"
                  min={1}
                  max={50}
                  value={config.ai_tagging_max_tags ?? 10}
                  onChange={(event) =>
                    updateConfig({ ai_tagging_max_tags: clampMaxTags(event.target.value) })
                  }
                />
              </Field>
              <Field label={t("config.ai.confidence")} htmlFor="ai-confidence">
                <Input
                  id="ai-confidence"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={config.ai_tagging_confidence_threshold ?? 0.5}
                  onChange={(event) =>
                    updateConfig({
                      ai_tagging_confidence_threshold: clampConfidence(event.target.value),
                    })
                  }
                />
              </Field>
            </div>

            {isLocalProvider && resolvedTier !== "off" && <AiModelManager />}
          </Disclosure>
        </>
      )}

      <SettingRow
        label={t("config.folder.categorize")}
        description={t("config.folder.categorizeHelp")}
        htmlFor="categorize-enabled"
        disabled={categorizeBlocked}
        disabledReason={categorizeReason}
      >
        <Toggle
          id="categorize-enabled"
          label={t("config.folder.categorize")}
          checked={config.categorize_enabled ?? false}
          disabled={categorizeBlocked}
          onChange={(value) => updateConfig({ categorize_enabled: value })}
        />
      </SettingRow>

      {config.categorize_enabled && !categorizeBlocked && (
        <Disclosure summary={t("config.folder.advanced")}>
          <Field label={t("config.folder.categories")} help={t("config.folder.categoriesHelp")}>
            <CategoryTagsInput
              categories={config.categorize_categories ?? []}
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
                className="mt-1.5 text-xs text-primary underline underline-offset-2"
              >
                {t("config.vocabulary.restore")}
              </button>
            )}
          </Field>
          <Field label={t("config.folder.confident")}>
            <CategorizeConfidenceSlider
              value={config.categorize_confidence_threshold ?? 0.55}
              onChange={(value) => updateConfig({ categorize_confidence_threshold: value })}
            />
          </Field>
          <Field label={t("config.folder.margin")} htmlFor="categorize-margin">
            <Input
              id="categorize-margin"
              type="number"
              min={0}
              max={0.5}
              step={0.05}
              value={config.categorize_min_margin ?? 0.15}
              onChange={(event) =>
                updateConfig({ categorize_min_margin: clampMargin(event.target.value) })
              }
              className="max-w-[8rem]"
            />
          </Field>
        </Disclosure>
      )}

      <SettingRow
        id="setting-rules"
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
        label={t("config.other.repair")}
        description={t("config.other.repairHelp")}
        htmlFor="repair-enabled"
      >
        <Toggle
          id="repair-enabled"
          label={t("config.other.repair")}
          checked={config.repair_enabled ?? true}
          onChange={(value) => updateConfig({ repair_enabled: value })}
        />
      </SettingRow>

      <SettingRow
        label={t("config.thumbnailCache.label")}
        description={t("config.thumbnailCache.help")}
        htmlFor="thumbnail-cache-enabled"
        last
      >
        <Toggle
          id="thumbnail-cache-enabled"
          label={t("config.thumbnailCache.label")}
          checked={config.thumbnail_cache_enabled}
          onChange={(value) => updateConfig({ thumbnail_cache_enabled: value })}
        />
        {config.thumbnail_cache_enabled && (
          <>
            <Input
              type="number"
              min={16}
              max={16384}
              step={16}
              aria-label={t("config.thumbnailCache.budget")}
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
          </>
        )}
      </SettingRow>
    </SettingGroup>
  );
}
