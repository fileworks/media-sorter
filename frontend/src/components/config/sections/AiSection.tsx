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

export function AiSection({ config, updateConfig }: SectionProps) {
  const { hardware } = useHardware();
  const currentLabels = config.ai_tagging_labels ?? DEFAULT_AI_LABELS;
  const categorizeCats = config.categorize_categories ?? [];
  const tooWeak = machineTooWeak(hardware);
  const localOff = hardware ? effectiveTier(config, hardware) === "off" : false;

  const syncFromCategories = () => {
    const existing = new Set(currentLabels.map((l) => l.toLowerCase()));
    const toAdd = categorizeCats.filter((c) => !existing.has(c.toLowerCase()));
    if (toAdd.length > 0) {
      updateConfig({ ai_tagging_labels: [...currentLabels, ...toAdd] });
    }
  };

  const canSync = categorizeCats.length > 0;

  return (
    <>
      <p className="text-xs text-muted-foreground">
        Writes descriptive keywords into files and the report. Does <strong>not</strong> change
        where files are placed — that's Smart Categorization.
      </p>
      <FormRow label="Tag media by content" htmlFor="ai-enabled" help={HELP.aiTagging} inline>
        <Toggle
          id="ai-enabled"
          checked={config.ai_tagging_enabled}
          onChange={(v) => updateConfig({ ai_tagging_enabled: v })}
        />
      </FormRow>

      {config.ai_tagging_enabled && (
        <div className="ml-2 space-y-3 border-l-2 border-border pl-3">
          <FormRow label="Provider" htmlFor="ai-provider" help={HELP.aiProvider} helpSide="right">
            <Select
              id="ai-provider"
              value={config.ai_tagging_provider}
              onValueChange={(v) =>
                updateConfig({ ai_tagging_provider: v as Config["ai_tagging_provider"] })
              }
              className="max-w-sm"
            >
              <SelectItem value="local">Local — offline, free, no key</SelectItem>
              <SelectItem value="azure_vision">Azure AI Vision — 5,000/mo free</SelectItem>
              <SelectItem value="imagga">Imagga — ~1,000/mo free</SelectItem>
              <SelectItem value="google_cloud_vision">Google Vision — 1,000/mo free</SelectItem>
            </Select>
          </FormRow>

          {config.ai_tagging_provider === "local" && (
            <>
              {/* Hardware capability + model-tier gating for the local encoder. */}
              {hardware && <AiCapabilityChip hardware={hardware} config={config} />}
              {hardware && !tooWeak && (
                <ModelTierSelect hardware={hardware} config={config} updateConfig={updateConfig} />
              )}

              {/* Label vocabulary is only meaningful when a local model runs. */}
              {!localOff && (
                <>
                  <FormRow label="Labels to detect" help={HELP.aiLabels} helpSide="right">
                    <>
                      {canSync && (
                        <div className="mb-1.5 flex items-center justify-end">
                          <button
                            type="button"
                            onClick={syncFromCategories}
                            className="text-xs text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
                            title="Add all Smart Categorization folders to the label list"
                          >
                            + Sync from Smart Categorization
                          </button>
                        </div>
                      )}
                      <AiTagsInput
                        labels={currentLabels}
                        onCommit={(next) => updateConfig({ ai_tagging_labels: next })}
                      />
                      {canSync &&
                        categorizeCats.every((c) =>
                          currentLabels.some((l) => l.toLowerCase() === c.toLowerCase()),
                        ) && (
                          <p className="mt-1 text-xs text-success">
                            All Smart Categorization folders are already in the label list.
                          </p>
                        )}
                    </>
                  </FormRow>
                </>
              )}
            </>
          )}

          {config.ai_tagging_provider === "azure_vision" && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <FormRow label="Endpoint" htmlFor="ai-azure-endpoint">
                <BlurCommitInput
                  id="ai-azure-endpoint"
                  type="text"
                  value={config.ai_tagging_endpoint}
                  onCommit={(v) => updateConfig({ ai_tagging_endpoint: v })}
                  placeholder="https://<resource>.cognitiveservices.azure.com"
                />
              </FormRow>
              <FormRow label="API key" htmlFor="ai-azure-key">
                <BlurCommitInput
                  id="ai-azure-key"
                  type="password"
                  value={config.ai_tagging_api_key}
                  onCommit={(v) => updateConfig({ ai_tagging_api_key: v })}
                  placeholder="Subscription key"
                />
              </FormRow>
              <p className="text-xs text-muted-foreground">
                Create a free <strong>Computer Vision</strong> resource (pricing tier{" "}
                <code>F0</code> — 5,000 images/month) in the{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://portal.azure.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  Azure portal
                </a>
                , then copy its <em>Endpoint</em> and a <em>Key</em>.
              </p>
            </div>
          )}

          {config.ai_tagging_provider === "imagga" && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <FormRow label="API key" htmlFor="ai-imagga-key">
                <BlurCommitInput
                  id="ai-imagga-key"
                  type="password"
                  value={config.ai_tagging_api_key}
                  onCommit={(v) => updateConfig({ ai_tagging_api_key: v })}
                  placeholder="Imagga API key"
                />
              </FormRow>
              <FormRow label="API secret" htmlFor="ai-imagga-secret">
                <BlurCommitInput
                  id="ai-imagga-secret"
                  type="password"
                  value={config.ai_tagging_api_secret}
                  onCommit={(v) => updateConfig({ ai_tagging_api_secret: v })}
                  placeholder="Imagga API secret"
                />
              </FormRow>
              <p className="text-xs text-muted-foreground">
                Sign up free at{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://imagga.com/auth/signup"
                  target="_blank"
                  rel="noreferrer"
                >
                  imagga.com
                </a>{" "}
                (~1,000 tags/month), then copy the <em>API key</em> and <em>secret</em> from your
                dashboard.
              </p>
            </div>
          )}

          {config.ai_tagging_provider === "google_cloud_vision" && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
              <FormRow label="API key" htmlFor="ai-google-key">
                <BlurCommitInput
                  id="ai-google-key"
                  type="password"
                  value={config.ai_tagging_api_key}
                  onCommit={(v) => updateConfig({ ai_tagging_api_key: v })}
                  placeholder="Google Cloud API key"
                />
              </FormRow>
              <p className="text-xs text-muted-foreground">
                In the{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://console.cloud.google.com/apis/library/vision.googleapis.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google Cloud console
                </a>{" "}
                enable the <strong>Vision API</strong> (1,000 images/month free), then create an{" "}
                <em>API key</em> under Credentials.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormRow label="Max tags per file" htmlFor="ai-max-tags">
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
              label="Confidence (0–1)"
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

          <FormRow label="Save tags into files" htmlFor="ai-embed" help={HELP.aiEmbed} inline>
            <Toggle
              id="ai-embed"
              checked={config.ai_tagging_embed_in_files ?? true}
              onChange={(v) => updateConfig({ ai_tagging_embed_in_files: v })}
            />
          </FormRow>
        </div>
      )}
    </>
  );
}
