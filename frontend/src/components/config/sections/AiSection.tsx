import { FormRow } from "@/components/ui/form-row";
import { Toggle } from "@/components/ui/toggle";
import { Select, SelectItem } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { BlurCommitInput } from "@/components/ui/blur-commit-input";
import { AiTagsInput } from "@/components/config/fields/AiTagsInput";
import { AiCapabilityChip, ModelTierSelect } from "@/components/config/fields/AiEngine";
import { HELP } from "@/components/config/help";
import { DEFAULT_AI_LABELS, clampMaxTags, clampConfidence } from "@/components/config/constants";
import { useHardware } from "@/hooks/useHardware";
import { effectiveTier, machineTooWeak } from "@/lib/aiTier";
import type { Config } from "@/types/api";
import type { SectionProps } from "@/components/config/constants";
import { useI18n } from "@/i18n/I18nContext";

export function AiSection({ config, updateConfig }: SectionProps) {
  const { t } = useI18n();
  const { hardware } = useHardware();
  const currentLabels = config.ai_tagging_labels ?? DEFAULT_AI_LABELS;
  const categorizeCats = config.categorize_categories ?? [];
  const tooWeak = machineTooWeak(hardware);
  const localOff = hardware ? effectiveTier(config, hardware) === "off" : false;

  const syncFromCategories = () => {
    const existing = new Set(currentLabels.map((l) => l.toLowerCase()));
    const toAdd = categorizeCats.filter((c) => !existing.has(c.toLowerCase()));
    if (toAdd.length > 0) {
      updateConfig({
        ai_tagging_labels: [...currentLabels, ...toAdd],
        ai_tagging_labels_provenance: "custom",
      });
    }
  };

  const canSync = categorizeCats.length > 0;

  return (
    <>
      <p className="text-xs text-muted-foreground">{t("config.ai.explanation")}</p>
      <FormRow label={t("config.ai.enabled")} htmlFor="ai-enabled" help={HELP.aiTagging} inline>
        <Toggle
          id="ai-enabled"
          checked={config.ai_tagging_enabled}
          onChange={(v) => updateConfig({ ai_tagging_enabled: v })}
        />
      </FormRow>

      <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t("config.ai.localEngine")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("config.ai.localEngineHelp")}</p>
        </div>
        {hardware && <AiCapabilityChip hardware={hardware} config={config} />}
        {hardware && !tooWeak && (
          <ModelTierSelect hardware={hardware} config={config} updateConfig={updateConfig} />
        )}
      </div>

      {config.ai_tagging_enabled && (
        <div className="ml-2 space-y-3 border-l-2 border-border pl-3">
          <FormRow
            label={t("config.ai.provider")}
            htmlFor="ai-provider"
            help={HELP.aiProvider}
            helpSide="right"
          >
            <Select
              id="ai-provider"
              value={config.ai_tagging_provider}
              onValueChange={(v) =>
                updateConfig({ ai_tagging_provider: v as Config["ai_tagging_provider"] })
              }
              className="max-w-sm"
            >
              <SelectItem value="local">{t("config.ai.local")}</SelectItem>
              <SelectItem value="azure_vision">{t("config.ai.azure")}</SelectItem>
              <SelectItem value="imagga">{t("config.ai.imagga")}</SelectItem>
              <SelectItem value="google_cloud_vision">{t("config.ai.google")}</SelectItem>
            </Select>
          </FormRow>

          {config.ai_tagging_provider === "local" && (
            <>
              {/* Label vocabulary is only meaningful when a local model runs. */}
              {!localOff && (
                <>
                  <FormRow label={t("config.ai.labels")} help={HELP.aiLabels} helpSide="right">
                    <>
                      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">
                          {t(
                            config.ai_tagging_labels_provenance === "bundled"
                              ? "config.vocabulary.bundled"
                              : "config.vocabulary.custom",
                          )}
                        </span>
                        {config.ai_tagging_labels_provenance === "custom" && (
                          <button
                            type="button"
                            className="text-primary underline underline-offset-2"
                            onClick={() =>
                              updateConfig({ ai_tagging_labels_provenance: "bundled" })
                            }
                          >
                            {t("config.vocabulary.restore")}
                          </button>
                        )}
                      </div>
                      {canSync && (
                        <div className="mb-1.5 flex items-center justify-end">
                          <button
                            type="button"
                            onClick={syncFromCategories}
                            className="text-xs text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
                            title={t("config.ai.syncTitle")}
                          >
                            {t("config.ai.sync")}
                          </button>
                        </div>
                      )}
                      <AiTagsInput
                        labels={currentLabels}
                        onCommit={(next) =>
                          updateConfig({
                            ai_tagging_labels: next,
                            ai_tagging_labels_provenance: "custom",
                          })
                        }
                      />
                      {canSync &&
                        categorizeCats.every((c) =>
                          currentLabels.some((l) => l.toLowerCase() === c.toLowerCase()),
                        ) && <p className="mt-1 text-xs text-success">{t("config.ai.synced")}</p>}
                    </>
                  </FormRow>
                </>
              )}
            </>
          )}

          {config.ai_tagging_provider === "azure_vision" && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <FormRow label={t("config.ai.endpoint")} htmlFor="ai-azure-endpoint">
                <BlurCommitInput
                  id="ai-azure-endpoint"
                  type="text"
                  value={config.ai_tagging_endpoint}
                  onCommit={(v) => updateConfig({ ai_tagging_endpoint: v })}
                  placeholder={t("config.ai.azureEndpointPlaceholder")}
                />
              </FormRow>
              <FormRow label={t("config.ai.apiKey")} htmlFor="ai-azure-key">
                <BlurCommitInput
                  id="ai-azure-key"
                  type="password"
                  value={config.ai_tagging_api_key}
                  onCommit={(v) => updateConfig({ ai_tagging_api_key: v })}
                  placeholder={t("config.ai.subscriptionKey")}
                />
              </FormRow>
              <p className="text-xs text-muted-foreground">
                {t("config.ai.azureHelp")}{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://portal.azure.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  Azure portal ↗
                </a>
              </p>
            </div>
          )}

          {config.ai_tagging_provider === "imagga" && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <FormRow label={t("config.ai.apiKey")} htmlFor="ai-imagga-key">
                <BlurCommitInput
                  id="ai-imagga-key"
                  type="password"
                  value={config.ai_tagging_api_key}
                  onCommit={(v) => updateConfig({ ai_tagging_api_key: v })}
                  placeholder={t("config.ai.imaggaKeyPlaceholder")}
                />
              </FormRow>
              <FormRow label={t("config.ai.apiSecret")} htmlFor="ai-imagga-secret">
                <BlurCommitInput
                  id="ai-imagga-secret"
                  type="password"
                  value={config.ai_tagging_api_secret}
                  onCommit={(v) => updateConfig({ ai_tagging_api_secret: v })}
                  placeholder={t("config.ai.imaggaSecretPlaceholder")}
                />
              </FormRow>
              <p className="text-xs text-muted-foreground">
                {t("config.ai.imaggaHelp")}{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://imagga.com/auth/signup"
                  target="_blank"
                  rel="noreferrer"
                >
                  imagga.com ↗
                </a>{" "}
              </p>
            </div>
          )}

          {config.ai_tagging_provider === "google_cloud_vision" && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <FormRow label={t("config.ai.apiKey")} htmlFor="ai-google-key">
                <BlurCommitInput
                  id="ai-google-key"
                  type="password"
                  value={config.ai_tagging_api_key}
                  onCommit={(v) => updateConfig({ ai_tagging_api_key: v })}
                  placeholder={t("config.ai.googleKeyPlaceholder")}
                />
              </FormRow>
              <p className="text-xs text-muted-foreground">
                {t("config.ai.googleHelp")}{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://console.cloud.google.com/apis/library/vision.googleapis.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google Cloud console ↗
                </a>{" "}
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormRow label={t("config.ai.maxTags")} htmlFor="ai-max-tags">
              <Input
                id="ai-max-tags"
                type="number"
                min={1}
                max={50}
                value={config.ai_tagging_max_tags ?? 10}
                onChange={(e) =>
                  updateConfig({ ai_tagging_max_tags: clampMaxTags(e.target.value) })
                }
              />
            </FormRow>
            <FormRow
              label={t("config.ai.confidence")}
              htmlFor="ai-confidence"
              help={HELP.aiConfidence}
              helpSide="right"
            >
              <Input
                id="ai-confidence"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={config.ai_tagging_confidence_threshold ?? 0.5}
                onChange={(e) =>
                  updateConfig({ ai_tagging_confidence_threshold: clampConfidence(e.target.value) })
                }
              />
            </FormRow>
          </div>

          <FormRow label={t("config.ai.embed")} htmlFor="ai-embed" help={HELP.aiEmbed} inline>
            <Toggle
              id="ai-embed"
              checked={config.embed_tags_in_files ?? true}
              onChange={(v) => updateConfig({ embed_tags_in_files: v })}
            />
          </FormRow>
        </div>
      )}
    </>
  );
}
