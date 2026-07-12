import type { ReactNode } from "react";
import {
  FiLayers,
  FiCopy,
  FiEdit3,
  FiRepeat,
  FiFilter,
  FiTag,
  FiSettings,
  FiCpu,
  FiSliders,
} from "react-icons/fi";
import type { SectionId } from "@/components/config/constants";

/** Rail groups — pure presentation: they only affect how the sidebar reads. */
export type SectionGroup = "Setup" | "Cleanup" | "Extras";

export const SECTION_META: {
  id: SectionId;
  label: string;
  description: string;
  icon: ReactNode;
  group: SectionGroup;
}[] = [
  {
    id: "essentials",
    group: "Setup",
    label: "Essentials",
    description:
      "The two choices that matter most — how files are dated and whether they're copied or moved.",
    icon: <FiSliders className="h-4 w-4" />,
  },
  {
    id: "folders",
    group: "Setup",
    label: "Folder structure",
    description: "How your sorted files are nested beneath each date folder.",
    icon: <FiLayers className="h-4 w-4" />,
  },
  {
    id: "duplicates",
    group: "Cleanup",
    label: "Duplicate detection",
    description: "Find duplicate photos and videos and set the lesser copies aside.",
    icon: <FiCopy className="h-4 w-4" />,
  },
  {
    id: "filters",
    group: "Cleanup",
    label: "Scan & filters",
    description: "Which files and folders to scan — and which to skip.",
    icon: <FiFilter className="h-4 w-4" />,
  },
  {
    id: "rename",
    group: "Extras",
    label: "Rename files",
    description: "Give sorted files consistent, date-based names.",
    icon: <FiEdit3 className="h-4 w-4" />,
  },
  {
    id: "conversion",
    group: "Extras",
    label: "Convert formats",
    description: "Standardize everything to one image and/or video format.",
    icon: <FiRepeat className="h-4 w-4" />,
  },
  {
    id: "rules",
    group: "Extras",
    label: "Tagging rules",
    description: "Tag files automatically by extension, size, resolution, or filename.",
    icon: <FiTag className="h-4 w-4" />,
  },
  {
    id: "ai",
    group: "Extras",
    label: "AI content tagging",
    description:
      "Describe photos and videos with content keywords — independent of folder placement.",
    icon: <FiCpu className="h-4 w-4" />,
  },
  {
    id: "other",
    group: "Extras",
    label: "Other options",
    description: "Metadata fixes and corruption repair.",
    icon: <FiSettings className="h-4 w-4" />,
  },
];
