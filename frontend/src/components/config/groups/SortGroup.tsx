/**
 * 01 Sort — how files travel and where they land.
 *
 * "Verify after transfer" is shown here as a stated guarantee rather than as a
 * switch. It is not configurable, and rendering it as a toggle somebody could
 * reach for and fail to move would be worse than saying plainly that every file
 * is re-read and checksummed before it counts as done.
 */

import { FiFolder } from "react-icons/fi";

import { DISK_BYTES_OPTS } from "@/components/config/constants";
import type { SectionProps } from "@/components/config/constants";
import { RenameBuilder } from "@/components/config/fields/RenameBuilder";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Segmented,
  SettingGroup,
  SettingPreview,
  SettingRow,
} from "@/components/ui/setting-row";
import { Toggle } from "@/components/ui/toggle";
import { useDiskSpace } from "@/hooks/useDiskSpace";
import { useI18n } from "@/i18n/I18nContext";
import { examplePath } from "@/lib/configSummary";
import { formatBytes } from "@/lib/formatters";
import type { Config } from "@/types/api";

/** The three date depths the folder structure can have, as one control. */
const STRUCTURES: { value: string; criteria: string[] }[] = [
  { value: "year", criteria: ["year"] },
  { value: "yearMonth", criteria: ["year", "month"] },
  { value: "yearMonthDay", criteria: ["year", "month", "day"] },
];

function structureKey(criteria: string[]): string {
  if (criteria.includes("day")) return "yearMonthDay";
  if (criteria.includes("month")) return "yearMonth";
  return "year";
}

export function SortGroup({ config, updateConfig }: SectionProps) {
  const { t, locale } = useI18n();
  const { diskSpace } = useDiskSpace();

  const free = diskSpace?.destination_free_bytes ?? null;
  const needed = diskSpace?.source_size_bytes ?? null;
  const freeKnown = diskSpace?.free_space_known !== false && free !== null;

  const transferDescription = (
    <>
      <span className="text-foreground">{t("config.copy")}</span>{" "}
      {needed !== null && freeKnown
        ? t("config.transfer.copyNeeds", {
            needed: formatBytes(needed, DISK_BYTES_OPTS),
            free: formatBytes(free ?? 0, DISK_BYTES_OPTS),
          })
        : t("config.transfer.copyPlain")}
      <br />
      <span className="text-foreground">{t("config.move")}</span>{" "}
      {t("config.transfer.movePlain")}
    </>
  );

  return (
    <SettingGroup
      id="group-sort"
      ordinal="01"
      title={t("config.group.sort.label")}
      subtitle={t("config.group.sort.description")}
    >
      <SettingRow
        id="setting-transfer"
        label={t("config.copyMove")}
        description={transferDescription}
      >
        <Segmented
          name="transfer-mode"
          label={t("config.copyMove")}
          value={config.copy_instead_of_move ? "copy" : "move"}
          options={[
            { value: "copy", label: t("config.copy") },
            { value: "move", label: t("config.move") },
          ]}
          onChange={(mode) => updateConfig({ copy_instead_of_move: mode === "copy" })}
        />
      </SettingRow>

      <SettingRow
        label={t("config.transfer.verify")}
        description={t("config.transfer.verifyHelp")}
      >
        <span className="rounded-full bg-tint-success px-2.5 py-1 text-3xs font-semibold text-success">
          {t("config.transfer.alwaysOn")}
        </span>
      </SettingRow>

      <SettingRow
        label={t("config.transfer.timestamps")}
        description={t("config.transfer.timestampsHelp")}
        htmlFor="preserve-timestamps"
      >
        <Toggle
          id="preserve-timestamps"
          label={t("config.transfer.timestamps")}
          checked={config.preservation_profile.preserve_filesystem_timestamps}
          onChange={(value) =>
            updateConfig({
              preservation_profile: {
                ...config.preservation_profile,
                preserve_filesystem_timestamps: value,
              },
            })
          }
        />
      </SettingRow>

      <SettingRow
        label={t("config.companions.label")}
        description={t("config.companions.help")}
        htmlFor="companion-handling"
      >
        <Select
          id="companion-handling"
          value={config.companion_handling}
          onValueChange={(value) =>
            updateConfig({ companion_handling: value as Config["companion_handling"] })
          }
          className="w-48"
        >
          <SelectItem value="keep_with_primary">{t("config.companions.keep")}</SelectItem>
          <SelectItem value="leave_in_place">{t("config.companions.leave")}</SelectItem>
          <SelectItem value="ignore">{t("config.companions.ignore")}</SelectItem>
        </Select>
      </SettingRow>

      <SettingRow
        id="setting-structure"
        label={t("config.folder.structure")}
        description={t("config.folder.structureHelp")}
      >
        <Toggle
          label={t("config.field.sortEnabled")}
          checked={config.sort}
          onChange={(value) => updateConfig({ sort: value })}
        />
        <Select
          id="folder-structure"
          aria-label={t("config.organizeDate")}
          value={structureKey(config.sort_criteria ?? ["year"])}
          disabled={!config.sort}
          onValueChange={(value) =>
            updateConfig({
              sort_criteria: STRUCTURES.find((s) => s.value === value)?.criteria ?? ["year"],
            })
          }
          className="w-44"
        >
          {STRUCTURES.map((structure) => (
            <SelectItem key={structure.value} value={structure.value}>
              {t(`config.date.${structure.value}`)}
            </SelectItem>
          ))}
        </Select>
      </SettingRow>

      <SettingPreview>
        <span className="break-all font-mono text-muted-foreground">
          <FiFolder className="mr-1.5 inline h-3 w-3 align-[-1px]" aria-hidden />
          {examplePath(config, t, locale)}
        </span>
        <span className="ml-3 text-faint">{t("config.folder.fallbackNote")}</span>
      </SettingPreview>

      <SettingRow
        label={t("config.folder.camera")}
        description={t("config.folder.cameraHelp")}
        htmlFor="camera-subfolder"
      >
        <Toggle
          id="camera-subfolder"
          label={t("config.folder.camera")}
          checked={config.camera_subfolder_enabled ?? false}
          onChange={(value) => updateConfig({ camera_subfolder_enabled: value })}
        />
      </SettingRow>

      <SettingRow
        label={t("config.folder.preserve")}
        description={t("config.folder.preserveHelp")}
        htmlFor="preserve-subfolders"
        disabled={config.categorize_enabled}
        disabledReason={
          config.categorize_enabled ? t("config.folder.categorizeActive") : undefined
        }
      >
        <Toggle
          id="preserve-subfolders"
          label={t("config.folder.preserve")}
          checked={config.preserve_subfolders}
          disabled={config.categorize_enabled}
          onChange={(value) => updateConfig({ preserve_subfolders: value })}
        />
      </SettingRow>

      <SettingRow
        id="setting-naming"
        label={t("config.rename.enabled")}
        description={t("config.rename.help")}
        htmlFor="rename-files"
        last={!config.rename}
      >
        <Toggle
          id="rename-files"
          label={t("config.rename.enabled")}
          checked={config.rename}
          onChange={(value) => updateConfig({ rename: value })}
        />
      </SettingRow>

      {config.rename && (
        <div className="px-5 py-3.5">
          <RenameBuilder
            configPattern={config.rename_pattern}
            onCommit={(value) => updateConfig({ rename_pattern: value })}
          />
        </div>
      )}
    </SettingGroup>
  );
}
