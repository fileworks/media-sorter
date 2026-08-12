/** Overlapping thumbnails that distinguish a duplicate set from one file. */

import { Thumbnail } from "@/components/ui/thumbnail";
import { cn } from "@/lib/utils";

export function StackVisual({
  paths,
  className,
}: {
  /** The set's copies. Only the first two are drawn; the count is the label's job. */
  paths: readonly string[];
  className?: string;
}) {
  const shown = paths.slice(0, 2);
  return (
    <span
      className={cn("relative block h-[2.375rem] w-[2.625rem] shrink-0", className)}
      aria-hidden
    >
      {shown.map((path, index) => (
        <Thumbnail
          key={path}
          path={path}
          maxPx={80}
          className={cn(
            "absolute h-[2.125rem] w-[2.125rem] rounded-[5px] border-2 border-card shadow-card",
            index === 0 ? "bottom-0 left-0" : "right-0 top-0",
          )}
        />
      ))}
    </span>
  );
}
