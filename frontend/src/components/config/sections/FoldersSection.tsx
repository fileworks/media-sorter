import { FormRow } from "@/components/ui/form-row";
import { Toggle } from "@/components/ui/toggle";
import { Input } from "@/components/ui/input";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { CategoryTagsInput } from "@/components/config/fields/CategoryTagsInput";
import { CategorizeConfidenceSlider } from "@/components/config/fields/CategorizeConfidenceSlider";
import { AiCapabilityChip } from "@/components/config/fields/AiEngine";
import { HELP } from "@/components/config/help";
import { clampMargin } from "@/components/config/constants";
import { useHardware } from "@/hooks/useHardware";
import { useAiSuggestions } from "@/hooks/useAiSuggestions";
import { isLocalAiOff, machineTooWeak } from "@/lib/aiTier";
import type { SectionProps } from "@/components/config/constants";

export function FoldersSection({ config, updateConfig }: SectionProps) {
  const { hardware } = useHardware();
  const {
    suggestions,
    loading: suggestLoading,
    error: suggestError,
    suggest,
    dismiss,
    clear,
  } = useAiSuggestions();
  // Smart Categorization is local-only, so it requires a usable local model.
  const localOff = hardware ? isLocalAiOff(config, hardware) : false;
  const tooWeak = machineTooWeak(hardware);
  const categorizeBlocked = config.preserve_subfolders || localOff;
  const categorizeReason = config.preserve_subfolders
    ? "Turn off Preserve subfolders first"
    : localOff
      ? tooWeak
        ? "This machine is below the minimum for local AI (needs ≥4 CPU cores and ≥4 GB RAM)"
        : "Turn the local AI model on under AI content tagging first"
      : undefined;

  const acceptSuggestion = (label: string) => {
    const existing = config.categorize_categories ?? [];
    if (!existing.some((c) => c.toLowerCase() === label.toLowerCase())) {
      updateConfig({ categorize_categories: [...existing, label] });
    }
    dismiss(label);
  };

  return (
    <>
      <FormRow
        label="Group by camera model"
        htmlFor="camera-subfolder"
        help={HELP.cameraSubfolder}
        inline
      >
        <Toggle
          id="camera-subfolder"
          checked={config.camera_subfolder_enabled ?? false}
          onChange={(v) => updateConfig({ camera_subfolder_enabled: v })}
        />
      </FormRow>

      <FormRow
        label="Smart Categorization"
        htmlFor="categorize-enabled"
        help={HELP.categorize}
        inline
        disabled={categorizeBlocked}
        disabledReason={categorizeReason}
      >
        <Toggle
          id="categorize-enabled"
          checked={config.categorize_enabled ?? false}
          disabled={categorizeBlocked}
          onChange={(v) => updateConfig({ categorize_enabled: v })}
        />
      </FormRow>

      {config.categorize_enabled && !categorizeBlocked && (
        <div className="ml-2 space-y-3 border-l-2 border-border pl-3">
          {hardware && <AiCapabilityChip hardware={hardware} config={config} />}
          <FormRow label="Categories" help={HELP.categorizeCategories} helpSide="right">
            <>
              {!localOff && (
                <div className="mb-1.5 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      clear();
                      void suggest(6);
                    }}
                    disabled={suggestLoading}
                    className="text-xs text-primary underline underline-offset-2 transition-colors hover:text-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Suggest category names by analysing a sample of your photos"
                  >
                    {suggestLoading ? "Analysing…" : "✦ Suggest from photos"}
                  </button>
                </div>
              )}
              <CategoryTagsInput
                categories={config.categorize_categories ?? []}
                onChange={(next) => updateConfig({ categorize_categories: next })}
              />
              {suggestError && <p className="mt-1 text-xs text-error">{suggestError}</p>}
              {suggestions.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  <p className="text-[11px] text-muted-foreground">Tap to add, × to dismiss:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <span
                        key={s}
                        className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 pl-2.5 pr-1 py-0.5 text-xs text-primary"
                      >
                        <button
                          type="button"
                          onClick={() => acceptSuggestion(s)}
                          className="font-medium hover:text-primary/70 transition-colors"
                        >
                          {s}
                        </button>
                        <button
                          type="button"
                          onClick={() => dismiss(s)}
                          className="text-muted-foreground hover:text-foreground transition-colors leading-none"
                          aria-label={`Dismiss ${s}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          </FormRow>

          {(config.categorize_categories ?? []).length === 0 && (
            <ValidationBadge
              severity="warning"
              message="No categories yet — every file will go to _uncategorized/ until you add some."
            />
          )}

          <FormRow
            label="Only sort when confident"
            help={HELP.categorizeConfidence}
            helpSide="right"
          >
            <CategorizeConfidenceSlider
              value={config.categorize_confidence_threshold ?? 0.55}
              onChange={(v) => updateConfig({ categorize_confidence_threshold: v })}
            />
          </FormRow>

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">Advanced</summary>
            <div className="mt-2">
              <FormRow
                label="Minimum margin"
                htmlFor="categorize-margin"
                help={HELP.categorizeMargin}
                helpSide="right"
              >
                <Input
                  id="categorize-margin"
                  type="number"
                  min={0}
                  max={0.5}
                  step={0.05}
                  value={config.categorize_min_margin ?? 0.15}
                  onChange={(e) =>
                    updateConfig({ categorize_min_margin: clampMargin(e.target.value) })
                  }
                  className="max-w-[8rem]"
                />
              </FormRow>
            </div>
          </details>
        </div>
      )}

      <FormRow
        label="Preserve source subfolders"
        htmlFor="preserve-subfolders"
        help={HELP.preserveSubfolders}
        inline
        disabled={config.categorize_enabled}
        disabledReason={
          config.categorize_enabled ? "Off while Smart Categorization is on" : undefined
        }
      >
        <Toggle
          id="preserve-subfolders"
          checked={config.preserve_subfolders}
          disabled={config.categorize_enabled}
          onChange={(v) => updateConfig({ preserve_subfolders: v })}
        />
      </FormRow>
    </>
  );
}
