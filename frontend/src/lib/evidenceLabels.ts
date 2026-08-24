/** Localized labels for typed Review evidence; unknown enums stay unknown. */

type Translate = (key: string, params?: Record<string, string | number>) => string;

const COMPANION_ROLE_KEYS: Readonly<Record<string, string>> = {
  edit_sidecar: "companion.role.editSidecar",
  motion_part: "companion.role.motionPart",
  raw_sibling: "companion.role.rawSibling",
  thumbnail_part: "companion.role.thumbnailPart",
  audio_note: "companion.role.audioNote",
};

const COMPANION_STATUS_KEYS: Readonly<Record<string, string>> = {
  attached: "companion.status.attached",
  left_in_place: "companion.status.leftInPlace",
};

const PLANNED_STATUS_KEYS: Readonly<Record<string, string>> = {
  sort: "review.plannedStatus.sort",
  organize: "review.plannedStatus.sort",
  review_only: "review.plannedStatus.keepInPlace",
  keep_in_place: "review.plannedStatus.keepInPlace",
  duplicate: "review.plannedStatus.duplicate",
  junk: "review.plannedStatus.junk",
  unknown_date: "review.plannedStatus.unknownDate",
  suspicious_date: "review.plannedStatus.suspiciousDate",
  future_date: "review.plannedStatus.futureDate",
  already_in_destination: "review.plannedStatus.alreadyThere",
  already_there: "review.plannedStatus.alreadyThere",
  failed: "review.plannedStatus.unreadable",
  unreadable: "review.plannedStatus.unreadable",
  baseline: "review.plannedStatus.baseline",
};

export function companionRoleLabel(role: string | null | undefined, t: Translate): string {
  if (role === null || role === undefined) return t("companion.role.unknown");
  const key = COMPANION_ROLE_KEYS[role];
  return key ? t(key) : t("companion.role.unknownValue", { value: role });
}

export function companionStatusLabel(status: string | null | undefined, t: Translate): string {
  if (status === null || status === undefined) return t("companion.status.unknown");
  const key = COMPANION_STATUS_KEYS[status];
  return key ? t(key) : t("companion.status.unknownValue", { value: status });
}

export function plannedStatusLabel(status: string | null | undefined, t: Translate): string {
  if (status === null || status === undefined) return t("review.plannedStatus.unknown");
  const key = PLANNED_STATUS_KEYS[status];
  return key ? t(key) : t("review.plannedStatus.unknownValue", { value: status });
}
