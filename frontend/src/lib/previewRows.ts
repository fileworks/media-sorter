/**
 * Pure row-flattening logic for the Preview tree view.
 *
 * Extracted from `PreviewList.tsx` so the (fairly involved) date / category /
 * duplicate bucketing is (a) independently unit-testable and (b) not a
 * non-component export inside a component file — which trips
 * `react-refresh/only-export-components`. `PreviewList` imports `FlatRow` and
 * `buildFlatRows` from here.
 */
import type { PreviewItem } from "@/types/api";

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export type FlatRow =
  | { kind: "year"; year: string; count: number }
  | { kind: "month"; year: string; month: string; monthName: string; count: number }
  | { kind: "day"; year: string; month: string; day: string; count: number }
  | { kind: "file"; item: PreviewItem; depth: 1 | 2 | 3 | 4 }
  | {
      kind: "cat-header";
      catKey: string;
      name: string;
      isUncategorized: boolean;
      count: number;
      depth: 1 | 2 | 3;
    }
  | { kind: "cat-file"; item: PreviewItem; catKey: string; catName: string; depth: 2 | 3 | 4 }
  | { kind: "date-dup-header"; bucketKey: string; count: number; depth: 1 | 2 | 3 }
  | { kind: "date-dup-file"; item: PreviewItem; bucketKey: string; depth: 2 | 3 | 4 }
  | {
      kind: "folder-header";
      folderKey: string;
      label: string;
      dest: string;
      icon: string;
      count: number;
    }
  | { kind: "folder-file"; item: PreviewItem; folderKey: string };

function pushDateGroupRows(
  rows: FlatRow[],
  dateItems: PreviewItem[],
  dupItems: PreviewItem[],
  dateKey: string,
  depth: 1 | 2 | 3,
  expanded: Set<string>,
  categorizeEnabled: boolean,
): void {
  if (!categorizeEnabled) {
    for (const item of dateItems) {
      rows.push({ kind: "file", item, depth });
    }
  } else {
    const catMap = new Map<string, PreviewItem[]>();
    for (const item of dateItems) {
      const key = item.category ?? "_uncategorized";
      if (!catMap.has(key)) catMap.set(key, []);
      catMap.get(key)!.push(item);
    }
    const sortedCats = [...catMap.keys()].sort((a, b) => {
      if (a === "_uncategorized") return 1;
      if (b === "_uncategorized") return -1;
      return a.localeCompare(b);
    });
    for (const catName of sortedCats) {
      const catItems = catMap.get(catName)!;
      const catKey = `${dateKey}-cat-${catName}`;
      const isUncategorized = catName === "_uncategorized";
      rows.push({
        kind: "cat-header",
        catKey,
        name: catName,
        isUncategorized,
        count: catItems.length,
        depth,
      });
      if (expanded.has(catKey)) {
        const catFileDepth = (depth + 1) as 2 | 3 | 4;
        for (const item of catItems) {
          rows.push({ kind: "cat-file", item, catKey, catName, depth: catFileDepth });
        }
      }
    }
  }
  if (dupItems.length > 0) {
    const dupBucketKey = `${dateKey}-dup`;
    rows.push({ kind: "date-dup-header", bucketKey: dupBucketKey, count: dupItems.length, depth });
    if (expanded.has(dupBucketKey)) {
      const fileDepth = Math.min(4, depth + 1) as 2 | 3 | 4;
      for (const item of dupItems) {
        rows.push({ kind: "date-dup-file", item, bucketKey: dupBucketKey, depth: fileDepth });
      }
    }
  }
}

export function buildFlatRows(
  items: PreviewItem[],
  expanded: Set<string>,
  sortCriteria: string[] = ["year", "month", "day"],
  categorizeEnabled = false,
): FlatRow[] {
  const rows: FlatRow[] = [];

  const useMonth = sortCriteria.includes("month");
  const useDay = useMonth && sortCriteria.includes("day");
  const fileDepth: 1 | 2 | 3 = useDay ? 3 : useMonth ? 2 : 1;

  const dateItems = items.filter((i) => i.status === "sort" || i.status === "suspicious_date");
  const unknownDateItems = items.filter((i) => i.status === "unknown_date");
  const futureDateItems = items.filter((i) => i.status === "future_date");
  const failedItems = items.filter((i) => i.status === "failed");
  const duplicateItems = items.filter((i) => i.status === "duplicate");
  const junkItems = items.filter((i) => i.status === "junk");
  // Destination-aware dedup outcomes get their own quarantine folder, exactly
  // like in-run duplicates — always quarantined, never deleted.
  const alreadyInDestItems = items.filter((i) => i.status === "already_in_destination");
  const duplicateUnknownItems = items.filter((i) => i.status === "duplicate_unknown");

  const datedMoveDuplicates = duplicateItems.filter((i) => !!i.extracted_date);
  const undatedMoveDuplicates = duplicateItems.filter((i) => !i.extracted_date);

  if (!useMonth) {
    const yearFileMap = new Map<string, PreviewItem[]>();
    for (const item of dateItems) {
      const year = (item.extracted_date ?? "").split("-")[0] || "Unknown";
      if (!yearFileMap.has(year)) yearFileMap.set(year, []);
      yearFileMap.get(year)!.push(item);
    }
    const dupYearMap = new Map<string, PreviewItem[]>();
    for (const dup of datedMoveDuplicates) {
      const year = (dup.extracted_date ?? "").split("-")[0] || "Unknown";
      if (!dupYearMap.has(year)) dupYearMap.set(year, []);
      dupYearMap.get(year)!.push(dup);
    }
    const allYears = new Set([...yearFileMap.keys(), ...dupYearMap.keys()]);
    for (const year of [...allYears].sort((a, b) => b.localeCompare(a))) {
      const yearItems = yearFileMap.get(year) ?? [];
      const dupYearItems = dupYearMap.get(year) ?? [];
      rows.push({ kind: "year", year, count: yearItems.length + dupYearItems.length });
      if (expanded.has(`y-${year}`)) {
        pushDateGroupRows(
          rows,
          yearItems,
          dupYearItems,
          `y-${year}`,
          fileDepth,
          expanded,
          categorizeEnabled,
        );
      }
    }
  } else if (!useDay) {
    type MonthFileMap = Map<string, PreviewItem[]>;
    type YearMonthMap = Map<string, MonthFileMap>;
    const yearMonthMap: YearMonthMap = new Map();
    for (const item of dateItems) {
      const parts = (item.extracted_date ?? "").split("-");
      const year = parts[0] || "Unknown";
      const month = parts[1] || "00";
      if (!yearMonthMap.has(year)) yearMonthMap.set(year, new Map());
      const mMap = yearMonthMap.get(year)!;
      if (!mMap.has(month)) mMap.set(month, []);
      mMap.get(month)!.push(item);
    }
    const dupYearMonthMap: YearMonthMap = new Map();
    for (const dup of datedMoveDuplicates) {
      const parts = (dup.extracted_date ?? "").split("-");
      const year = parts[0] || "Unknown";
      const month = parts[1] || "00";
      if (!dupYearMonthMap.has(year)) dupYearMonthMap.set(year, new Map());
      const mMap = dupYearMonthMap.get(year)!;
      if (!mMap.has(month)) mMap.set(month, []);
      mMap.get(month)!.push(dup);
    }
    const allYears = new Set([...yearMonthMap.keys(), ...dupYearMonthMap.keys()]);
    for (const year of [...allYears].sort((a, b) => b.localeCompare(a))) {
      const mMap = yearMonthMap.get(year) ?? new Map();
      const dupMMap = dupYearMonthMap.get(year) ?? new Map();
      let yearCount = 0;
      for (const monthItems of mMap.values()) yearCount += monthItems.length;
      for (const dupMonthItems of dupMMap.values()) yearCount += dupMonthItems.length;
      rows.push({ kind: "year", year, count: yearCount });
      if (!expanded.has(`y-${year}`)) continue;
      const allMonths = new Set([...mMap.keys(), ...dupMMap.keys()]);
      for (const month of [...allMonths].sort((a, b) => b.localeCompare(a))) {
        const monthItems = mMap.get(month) ?? [];
        const dupMonthItems = dupMMap.get(month) ?? [];
        const monthNum = parseInt(month, 10);
        const monthName = MONTH_NAMES[monthNum - 1] ?? month;
        rows.push({
          kind: "month",
          year,
          month,
          monthName,
          count: monthItems.length + dupMonthItems.length,
        });
        if (expanded.has(`m-${year}-${month}`)) {
          pushDateGroupRows(
            rows,
            monthItems,
            dupMonthItems,
            `m-${year}-${month}`,
            fileDepth,
            expanded,
            categorizeEnabled,
          );
        }
      }
    }
  } else {
    type DayMap = Map<string, PreviewItem[]>;
    type MonthMap = Map<string, DayMap>;
    type YearMap = Map<string, MonthMap>;
    const yearMap: YearMap = new Map();
    for (const item of dateItems) {
      const parts = (item.extracted_date ?? "").split("-");
      const year = parts[0] || "Unknown";
      const month = parts[1] || "00";
      const day = parts[2] || "00";
      if (!yearMap.has(year)) yearMap.set(year, new Map());
      const mMap = yearMap.get(year)!;
      if (!mMap.has(month)) mMap.set(month, new Map());
      const dMap = mMap.get(month)!;
      if (!dMap.has(day)) dMap.set(day, []);
      dMap.get(day)!.push(item);
    }
    const dupYearMap: YearMap = new Map();
    for (const dup of datedMoveDuplicates) {
      const parts = (dup.extracted_date ?? "").split("-");
      const year = parts[0] || "Unknown";
      const month = parts[1] || "00";
      const day = parts[2] || "00";
      if (!dupYearMap.has(year)) dupYearMap.set(year, new Map());
      const mMap = dupYearMap.get(year)!;
      if (!mMap.has(month)) mMap.set(month, new Map());
      const dMap = mMap.get(month)!;
      if (!dMap.has(day)) dMap.set(day, []);
      dMap.get(day)!.push(dup);
    }
    const allYears = new Set([...yearMap.keys(), ...dupYearMap.keys()]);
    for (const year of [...allYears].sort((a, b) => b.localeCompare(a))) {
      const mMap = yearMap.get(year) ?? new Map();
      const dupMMap = dupYearMap.get(year) ?? new Map();
      let yearCount = 0;
      for (const dMap of mMap.values())
        for (const dayItems of dMap.values()) yearCount += dayItems.length;
      for (const dMap of dupMMap.values())
        for (const dupDayItems of dMap.values()) yearCount += dupDayItems.length;
      rows.push({ kind: "year", year, count: yearCount });
      if (!expanded.has(`y-${year}`)) continue;
      const allMonths = new Set([...mMap.keys(), ...dupMMap.keys()]);
      for (const month of [...allMonths].sort((a, b) => b.localeCompare(a))) {
        const dMap = mMap.get(month) ?? new Map();
        const dupDMap = dupMMap.get(month) ?? new Map();
        let monthCount = 0;
        for (const dayItems of dMap.values()) monthCount += dayItems.length;
        for (const dupDayItems of dupDMap.values()) monthCount += dupDayItems.length;
        const monthNum = parseInt(month, 10);
        const monthName = MONTH_NAMES[monthNum - 1] ?? month;
        rows.push({ kind: "month", year, month, monthName, count: monthCount });
        if (!expanded.has(`m-${year}-${month}`)) continue;
        const allDays = new Set([...dMap.keys(), ...dupDMap.keys()]);
        for (const day of [...allDays].sort((a, b) => b.localeCompare(a))) {
          const dayItems = dMap.get(day) ?? [];
          const dupDayItems = dupDMap.get(day) ?? [];
          rows.push({ kind: "day", year, month, day, count: dayItems.length + dupDayItems.length });
          if (expanded.has(`d-${year}-${month}-${day}`)) {
            pushDateGroupRows(
              rows,
              dayItems,
              dupDayItems,
              `d-${year}-${month}-${day}`,
              fileDepth,
              expanded,
              categorizeEnabled,
            );
          }
        }
      }
    }
  }

  const folderSections: {
    key: string;
    label: string;
    dest: string;
    icon: string;
    items: PreviewItem[];
  }[] = [
    {
      key: "duplicates",
      label: "_duplicates/",
      dest: "_duplicates/",
      icon: "≈",
      items: undatedMoveDuplicates,
    },
    {
      key: "unknown_date",
      label: "_unknown_dates/",
      dest: "_unknown_dates/",
      icon: "⚠",
      items: unknownDateItems,
    },
    {
      key: "future_date",
      label: "_future_dates/",
      dest: "_future_dates/",
      icon: "⚠",
      items: futureDateItems,
    },
    { key: "failed", label: "_failed/", dest: "_failed/", icon: "✕", items: failedItems },
    { key: "junk", label: "_junk/", dest: "_junk/", icon: "🗑", items: junkItems },
    {
      key: "already_in_destination",
      label: "_already_in_destination/",
      dest: "_already_in_destination/",
      icon: "≈",
      items: alreadyInDestItems,
    },
    {
      key: "duplicate_unknown",
      label: "Needs full sort check",
      dest: "",
      icon: "?",
      items: duplicateUnknownItems,
    },
  ];
  folderSections.sort((a, b) => a.label.localeCompare(b.label));
  for (const { key, label, dest, icon, items: groupItems } of folderSections) {
    if (groupItems.length === 0) continue;
    rows.push({
      kind: "folder-header",
      folderKey: key,
      label,
      dest,
      icon,
      count: groupItems.length,
    });
    if (expanded.has(`folder-${key}`)) {
      for (const item of groupItems) {
        rows.push({ kind: "folder-file", item, folderKey: key });
      }
    }
  }

  return rows;
}
