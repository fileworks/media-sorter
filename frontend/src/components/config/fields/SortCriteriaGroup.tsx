import { cn } from "@/lib/utils";

const OPTIONS = [
  { label: "Year", value: ["year"] as string[] },
  { label: "Year + Month", value: ["year", "month"] as string[] },
  { label: "Year + Month + Day", value: ["year", "month", "day"] as string[] },
];

export function SortCriteriaGroup({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const activeKey = value.includes("day")
    ? "Year + Month + Day"
    : value.includes("month")
      ? "Year + Month"
      : "Year";

  return (
    <div className="flex flex-col gap-1.5 sm:flex-row">
      {OPTIONS.map((opt) => (
        <label
          key={opt.label}
          className={cn(
            "flex flex-1 cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors",
            activeKey === opt.label
              ? "border-primary bg-primary/10 text-foreground"
              : "border-input bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
          )}
        >
          <input
            type="radio"
            name="sort-criteria"
            className="accent-primary"
            checked={activeKey === opt.label}
            onChange={() => onChange(opt.value)}
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  );
}
