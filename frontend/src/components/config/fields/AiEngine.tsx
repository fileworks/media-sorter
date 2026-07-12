import { FiCpu, FiAlertTriangle, FiZap } from "react-icons/fi";
import { FormRow } from "@/components/ui/form-row";
import { Select, SelectItem } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import { HELP } from "@/components/config/help";
import { cn } from "@/lib/utils";
import type { AiModelTier, Config, HardwareInfo } from "@/types/api";
import {
  TIER_LABEL,
  TIER_RANK,
  effectiveTier,
  machineSummary,
  machineTooWeak,
  type ResolvedTier,
} from "@/lib/aiTier";

/**
 * Capability chip: tells the user, in one line, whether their machine can run
 * local AI and which tier is recommended. Honest auto-disable lives here — when
 * the probe says "off", this reads as a clear blocker, not a silent greying-out.
 */
export function AiCapabilityChip({ hardware, config }: { hardware: HardwareInfo; config: Config }) {
  const tooWeak = machineTooWeak(hardware);
  const eff = effectiveTier(config, hardware);

  if (tooWeak) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        <FiAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          This machine is below the minimum for local AI (needs ≥4 CPU cores and ≥4 GB RAM). Smart
          Categorization is unavailable; for AI tagging, use a cloud provider below.
          <span className="mt-0.5 block text-warning/80">{machineSummary(hardware)}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <FiCpu className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span>
        <span className="font-medium text-foreground">{machineSummary(hardware)}</span>
        {" · "}
        Recommended:{" "}
        <span className="font-medium text-foreground">{TIER_LABEL[hardware.recommended_tier]}</span>
        {eff !== "off" && eff !== hardware.recommended_tier && (
          <span className="text-warning"> · running {TIER_LABEL[eff]}</span>
        )}
      </span>
      {hardware.has_accelerator && (
        <span className="ml-auto flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-success">
          <FiZap className="h-3 w-3" /> GPU
        </span>
      )}
    </div>
  );
}

/**
 * Model-tier selector + GPU toggle for the local encoder. Options above what the
 * hardware comfortably handles are flagged "may be slow"; the recommended tier is
 * marked so "Auto" is an informed choice.
 */
export function ModelTierSelect({
  hardware,
  config,
  updateConfig,
}: {
  hardware: HardwareInfo;
  config: Config;
  updateConfig: (patch: Partial<Config>) => void;
}) {
  const recommended = hardware.recommended_tier;
  const tier = config.ai_model_tier ?? "auto";

  const slowFlag = (t: ResolvedTier): string =>
    recommended !== "off" && TIER_RANK[t] > TIER_RANK[recommended] ? " · may be slow" : "";

  const options: { value: AiModelTier; label: string }[] = [
    { value: "auto", label: `Auto — use ${TIER_LABEL[recommended]} (recommended)` },
    { value: "lite", label: `Lite — fast, runs anywhere${slowFlag("lite")}` },
    { value: "standard", label: `Standard — more accurate${slowFlag("standard")}` },
    { value: "max", label: `Max — best quality${slowFlag("max")}` },
    { value: "off", label: "Off — disable the local model" },
  ];

  const eff = effectiveTier(config, hardware);

  return (
    <div className="space-y-3">
      <FormRow
        label="Local AI model"
        htmlFor="ai-model-tier"
        help={HELP.aiModelTier}
        helpSide="right"
      >
        <Select
          id="ai-model-tier"
          value={tier}
          onValueChange={(v) => updateConfig({ ai_model_tier: v as AiModelTier })}
          className="max-w-sm"
        >
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </Select>
      </FormRow>

      {/* GPU toggle only matters when an accelerator EP is actually present. */}
      {hardware.has_accelerator && eff !== "off" && (
        <FormRow label="Use GPU acceleration" htmlFor="ai-allow-gpu" help={HELP.aiAllowGpu} inline>
          <Toggle
            id="ai-allow-gpu"
            checked={config.ai_allow_gpu ?? true}
            onChange={(v) => updateConfig({ ai_allow_gpu: v })}
          />
        </FormRow>
      )}

      <p className={cn("text-xs text-muted-foreground")}>
        Standard / Max download a one-time model (~100 MB) on first use and run fully offline
        afterwards.
      </p>
    </div>
  );
}
