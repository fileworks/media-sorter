/**
 * Helpers for the local-AI model tier ↔ hardware capability gating.
 *
 * Mirrors the backend's `HardwareProfile.effective_tier`: "auto" resolves to the
 * probe's recommendation; an explicit tier is honoured. When the effective tier
 * is "off" the machine can't run local AI at all, so the UI disables the
 * local-only features (Smart Categorization). There is no cloud fallback.
 */
import type { AiModelTier, Config, HardwareInfo } from "@/types/api";

/** The tiers that exist: one shipped model (SigLIP 2) or none. */
export type ResolvedTier = "off" | "standard";
/** What the setting can show and save. */
export type SelectableTier = "auto" | ResolvedTier;

/**
 * Saved settings from releases that offered Lite (CLIP) and Max (the same SigLIP
 * model) select the one shipped model, exactly as the backend resolves them.
 */
export function normalizeTier(tier: AiModelTier | undefined): SelectableTier {
  if (tier === "lite" || tier === "max") return "standard";
  return tier ?? "auto";
}

export const TIER_RANK: Record<ResolvedTier, number> = { off: 0, standard: 1 };

export const TIER_LABEL: Record<SelectableTier, string> = {
  auto: "Auto",
  off: "Off",
  standard: "Standard",
};

/** The tier that will actually run, given the user's choice + the hardware probe. */
export function effectiveTier(config: Config, hardware: HardwareInfo | undefined): ResolvedTier {
  const choice = normalizeTier(config.ai_model_tier);
  if (choice === "auto") {
    const recommended = normalizeTier(hardware?.recommended_tier ?? "standard");
    return recommended === "auto" ? "standard" : recommended;
  }
  return choice;
}

/** True when local AI can't run on this machine (too weak, or explicitly off). */
export function isLocalAiOff(config: Config, hardware: HardwareInfo | undefined): boolean {
  return effectiveTier(config, hardware) === "off";
}

/** True when the machine is below the minimum for any local AI (probe says off). */
export function machineTooWeak(hardware: HardwareInfo | undefined): boolean {
  return hardware?.recommended_tier === "off";
}

/** Short machine summary, e.g. "8 cores · 16 GB · GPU". */
export function machineSummary(hardware: HardwareInfo): string {
  const parts = [`${hardware.logical_cpus} cores`, `${Math.round(hardware.total_ram_gb)} GB`];
  if (hardware.has_accelerator) parts.push("GPU");
  return parts.join(" · ");
}
