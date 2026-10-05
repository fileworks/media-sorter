import { describe, expect, it } from "vitest";
import { translate } from "@/i18n/I18nContext";
import { mediaUnitExplanation, mediaUnitLabel } from "@/lib/mediaUnitLabels";
import { toReviewRows, type ReviewRow } from "@/lib/reviewRows";
import type { PreviewResult } from "@/types/api";

const t = (key: string, params?: Record<string, string | number>) => translate("de", key, params);
const row = {
  name: "IMG_1234.jpg",
  unitPrimary: true,
  companions: [
    {
      source: "C:\\input\\IMG_1234.xmp",
      destination: "C:\\out\\IMG_1234.xmp",
      role: "edit_sidecar",
      status: "attached",
      warning: null,
    },
  ],
} satisfies Pick<ReviewRow, "name" | "unitPrimary" | "companions">;

describe("real associated files, rather than internal unit IDs", () => {
  it("names the detected type and exact files and explains their placement", () => {
    expect(mediaUnitLabel(row, t)).toBe("mit XMP");
    expect(mediaUnitExplanation(row, t)).toContain("IMG_1234.jpg + IMG_1234.xmp");
    expect(mediaUnitExplanation(row, t)).toContain("keine zusätzlichen Duplikatkopien");
    expect(mediaUnitExplanation(row, t)).toContain("_copies/");
  });

  it("does not mark standalone photos that happen to have a unit ID", () => {
    const [standalone] = toReviewRows({
      items: [
        {
          source: "/input/photo.jpg",
          destination: "/out/photo.jpg",
          status: "sort",
          extracted_date: null,
          metadata_source: "none",
          tags: [],
          unit_id: "internal",
          unit_primary: true,
          companions: [],
        },
      ],
    } as unknown as PreviewResult);
    expect(standalone.flags).not.toContain("unit_member");
    expect(mediaUnitLabel(standalone, t)).toBeNull();
    expect(mediaUnitExplanation(standalone, t)).toBeNull();
  });

  it("never promises that an excluded or unknown file follows the photo", () => {
    const excluded = {
      ...row,
      companions: [{ ...row.companions[0], status: "left_in_place" as const }],
    };
    expect(mediaUnitExplanation(excluded, t)).toContain("bleiben am Quellort");
    expect(mediaUnitExplanation(excluded, t)).not.toContain("werden zusammen");
    const unknown = {
      ...row,
      companions: [{ ...row.companions[0], status: "future-status" }],
    } as unknown as typeof row;
    expect(mediaUnitExplanation(unknown, t)).toContain("unbekannt");
    expect(mediaUnitExplanation(unknown, t)).not.toContain("werden zusammen");
  });
});
