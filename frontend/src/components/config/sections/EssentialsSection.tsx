import { FormRow } from "@/components/ui/form-row";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { formatBytes } from "@/lib/formatters";
import { useDiskSpace } from "@/hooks/useDiskSpace";
import { cn } from "@/lib/utils";
import { FiFolder, FiFolderPlus, FiCheckCircle, FiAlertCircle } from "react-icons/fi";
import { SortCriteriaGroup } from "@/components/config/fields/SortCriteriaGroup";
import { DirectoryInput } from "@/components/config/fields/DirectoryInput";
import { HELP } from "@/components/config/help";
import { DISK_BYTES_OPTS } from "@/components/config/constants";
import type { SectionProps } from "@/components/config/constants";

export function EssentialsSection({ config, updateConfig, fieldErrors }: SectionProps) {
  const { diskSpace } = useDiskSpace();

  const pickDirectory = async (field: "source_directory" | "target_directory") => {
    try {
      const { open } = await import("@tauri-apps/api/dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        updateConfig({ [field]: selected });
      }
    } catch {
      // Dialog cancelled or Tauri unavailable in browser dev mode
    }
  };

  const src = config.source_directory ?? "";
  const dest = config.target_directory ?? "";
  // Server-validated problems for each path (empty, not-found, not-a-dir, same
  // folder). Destination messages stay hidden until a source is chosen so the
  // very first screen prompts for one field at a time.
  const srcErrors = fieldErrors.get("source_directory") ?? [];
  const destErrors = src ? (fieldErrors.get("target_directory") ?? []) : [];
  const showDiskSpace =
    config.copy_instead_of_move &&
    src &&
    dest &&
    src !== dest &&
    diskSpace != null &&
    typeof diskSpace.destination_free_bytes === "number";

  return (
    <>
      <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
        <div className="space-y-1.5">
          <label
            htmlFor="source-dir"
            className="flex items-center gap-1.5 text-xs font-medium text-foreground"
          >
            <FiFolder className="h-3.5 w-3.5 text-muted-foreground" />
            Source folder{" "}
            <span className="text-destructive" aria-hidden>
              *
            </span>
          </label>
          <DirectoryInput
            id="source-dir"
            value={src}
            placeholder="Select or type a path…"
            invalid={srcErrors.length > 0}
            onCommit={(v) => updateConfig({ source_directory: v })}
            onBrowse={() => void pickDirectory("source_directory")}
          />
          {srcErrors.map((msg) => (
            <ValidationBadge key={msg} message={msg} severity="error" />
          ))}
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="target-dir"
            className="flex items-center gap-1.5 text-xs font-medium text-foreground"
          >
            <FiFolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
            Destination folder{" "}
            <span className="text-destructive" aria-hidden>
              *
            </span>
          </label>
          <DirectoryInput
            id="target-dir"
            value={dest}
            placeholder="Select or type a path…"
            invalid={destErrors.length > 0}
            onCommit={(v) => updateConfig({ target_directory: v })}
            onBrowse={() => void pickDirectory("target_directory")}
          />
          {destErrors.map((msg) => (
            <ValidationBadge key={msg} message={msg} severity="error" />
          ))}
          {showDiskSpace &&
            diskSpace &&
            (diskSpace.free_space_known === false ? (
              <div className="flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning">
                <FiAlertCircle className="h-3.5 w-3.5 shrink-0" />
                Couldn&apos;t read free space at the destination — check the folder&apos;s
                permissions.
              </div>
            ) : (
              <div
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium",
                  diskSpace.sufficient
                    ? "border-success/20 bg-success/10 text-success"
                    : "border-destructive/20 bg-destructive/10 text-destructive",
                )}
              >
                {diskSpace.sufficient ? (
                  <>
                    <FiCheckCircle className="h-3.5 w-3.5 shrink-0" />
                    {formatBytes(diskSpace.destination_free_bytes, DISK_BYTES_OPTS)} free —
                    sufficient for copy (needs{" "}
                    {formatBytes(diskSpace.source_size_bytes, DISK_BYTES_OPTS)})
                  </>
                ) : (
                  <>
                    <FiAlertCircle className="h-3.5 w-3.5 shrink-0" />
                    Only {formatBytes(diskSpace.destination_free_bytes, DISK_BYTES_OPTS)} free — not
                    enough for copy (needs{" "}
                    {formatBytes(diskSpace.source_size_bytes, DISK_BYTES_OPTS)}). Switch to Move or
                    free up space.
                  </>
                )}
              </div>
            ))}
        </div>
      </div>

      <FormRow label="Organize by date" help={HELP.sortBy} helpSide="right">
        <SortCriteriaGroup
          value={config.sort_criteria ?? ["year"]}
          onChange={(v) => updateConfig({ sort_criteria: v })}
        />
      </FormRow>

      <FormRow label="Copy or move" help={HELP.copyVsMove} helpSide="right">
        <div className="flex gap-4">
          {(["copy", "move"] as const).map((mode) => (
            <label key={mode} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="copy-move"
                value={mode}
                checked={
                  mode === "copy" ? config.copy_instead_of_move : !config.copy_instead_of_move
                }
                onChange={() => updateConfig({ copy_instead_of_move: mode === "copy" })}
                className="accent-primary"
              />
              <span className="text-sm capitalize">{mode}</span>
            </label>
          ))}
        </div>
      </FormRow>
    </>
  );
}
