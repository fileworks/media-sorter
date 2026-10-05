import type { ReviewRow } from "@/lib/reviewRows";
import { getBasename } from "@/lib/pathUtils";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type UnitFiles = Pick<ReviewRow, "name" | "unitPrimary" | "companions" | "unitWarnings">;

/** Internal unit IDs also exist for standalone photos; only name actual relationships. */
export function mediaUnitLabel(row: UnitFiles, t: Translate): string | null {
  const companions = row.companions ?? [];
  if (companions.length === 0) {
    return row.unitPrimary === false ? t("review.unit.attachedFile") : null;
  }
  const extensions = [
    ...new Set(
      companions.map((file) => {
        const name = getBasename(file.source);
        const separator = name.lastIndexOf(".");
        return separator > 0 ? name.slice(separator + 1).toUpperCase() : null;
      }),
    ),
  ];
  return extensions.every((extension) => extension !== null) && extensions.length <= 2
    ? t("review.unit.withTypes", { types: extensions.join(" + ") })
    : t("review.unit.withFiles", { count: companions.length });
}

export function mediaUnitExplanation(row: UnitFiles, t: Translate): string | null {
  const companions = row.companions ?? [];
  if (companions.length === 0) {
    return row.unitPrimary === false ? t("review.unit.attachedFile.help") : null;
  }
  const following = companions.filter((file) => file.status === "attached");
  const left = companions.filter((file) => file.status === "left_in_place");
  const unknown = companions.filter(
    (file) => file.status !== "attached" && file.status !== "left_in_place",
  );
  return [
    t("review.unit.files", {
      files: [row.name, ...companions.map((file) => getBasename(file.source))].join(" + "),
    }),
    companions.some((file) => file.source.toLowerCase().endsWith(".xmp"))
      ? t("review.unit.xmp")
      : null,
    companions.some((file) => file.role === "motion_part") ? t("review.unit.motion") : null,
    following.length > 0
      ? t("review.unit.follow", {
          file: row.name,
          files: following.map((file) => getBasename(file.source)).join(", "),
        })
      : null,
    left.length > 0
      ? t("review.unit.left", { files: left.map((file) => getBasename(file.source)).join(", ") })
      : null,
    unknown.length > 0
      ? t("review.unit.unknown", {
          files: unknown.map((file) => getBasename(file.source)).join(", "),
        })
      : null,
    ...(row.unitWarnings ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}
