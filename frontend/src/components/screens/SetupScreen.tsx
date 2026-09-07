import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";

/** Choose a starting point; detailed settings are optional within the same step. */
export function SetupScreen({
  recipe,
  settings,
  locked,
  adjusting,
  onAdjustingChange,
}: {
  recipe: ReactNode;
  settings: (onBack: () => void) => ReactNode;
  locked: boolean;
  adjusting: boolean;
  onAdjustingChange: (adjusting: boolean) => void;
}) {
  const { t } = useI18n();
  const content = useRef<HTMLDivElement>(null);
  const previousAdjusting = useRef(adjusting);
  useEffect(() => {
    if (previousAdjusting.current === adjusting) return;
    previousAdjusting.current = adjusting;
    // The invoking button unmounts. Keep the keyboard at the new surface's way back.
    content.current
      ?.querySelector<HTMLElement>(adjusting ? "[data-open-recipes]" : "[data-open-settings]")
      ?.focus();
  }, [adjusting]);
  return (
    <div ref={content} className="space-y-4">
      {adjusting ? (
        settings(() => onAdjustingChange(false))
      ) : (
        <>
          <div className="flex justify-end">
            <Button
              data-open-settings
              variant="outline"
              size="sm"
              onClick={() => onAdjustingChange(true)}
            >
              {t("setup.adjustSettings")}
            </Button>
          </div>
          <fieldset
            disabled={locked}
            className={cn("m-0 min-w-0 border-0 p-0", locked && "read-only-region")}
          >
            {recipe}
          </fieldset>
        </>
      )}
    </div>
  );
}
