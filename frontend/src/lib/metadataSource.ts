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
  // Narrowed on the trimmed value rather than asserting `source` non-null
  // afterwards: the assertion was true, but only a reader could know that.
  const trimmed = source?.trim();
  if (!trimmed) return t("metadataSource.none");

  const normalized = trimmed.toLowerCase();
  if (normalized === "none") return t("metadataSource.none");

  const key = SOURCE_KEYS[normalized];
  if (key) return t(key);

  return trimmed.replace(/_/g, " ");
}
