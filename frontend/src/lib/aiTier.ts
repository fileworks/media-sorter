/**
 * Helpers for the local-AI model tier ↔ hardware capability gating.
 *
 * Mirrors the backend's `HardwareProfile.effective_tier`: "auto" resolves to the
 * probe's recommendation; an explicit tier is honoured. When the effective tier
 * is "off" the machine can't run local AI at all, so the UI disables the
 * local-only features (Smart Categorization) and steers tagging to a cloud
 * provider.
 */
import type { AiModelTier, Config, HardwareInfo } from "@/types/api";

export type ResolvedTier = Exclude<AiModelTier, "auto">;

export const TIER_RANK: Record<ResolvedTier, number> = { off: 0, lite: 1, standard: 2, max: 3 };

export const TIER_LABEL: Record<AiModelTier, string> = {
  auto: "Auto",
  off: "Off",
  lite: "Lite",
  standard: "Standard",
  max: "Max",
};

/** The tier that will actually run, given the user's choice + the hardware probe. */
export function effectiveTier(config: Config, hardware: HardwareInfo | undefined): ResolvedTier {
  const choice = config.ai_model_tier ?? "auto";
  if (choice === "auto") return hardware?.recommended_tier ?? "lite";
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
