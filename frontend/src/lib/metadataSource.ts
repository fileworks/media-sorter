type Translate = (
  key: string,
  params?: Record<string, string | number>,
  fallback?: string,
) => string;

const SOURCE_KEYS: Record<string, string> = {
  exif: "metadataSource.exif",
  video_metadata: "metadataSource.videoMetadata",
  filename: "metadataSource.filename",
  filesystem: "metadataSource.filesystem",
};

export function formatMetadataSource(source: string | null | undefined, t: Translate): string {
  const normalized = source?.trim().toLowerCase();
  if (!normalized || normalized === "none") return t("metadataSource.none");

  const key = SOURCE_KEYS[normalized];
  if (key) return t(key);

  return source!.replace(/_/g, " ");
}
