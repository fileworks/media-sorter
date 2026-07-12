export function ExcludePatternTags({
  patterns,
  onAdd,
  onRemove,
}: {
  patterns: string[];
  onAdd: (p: string) => void;
  onRemove: (p: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {patterns.map((pattern) => (
        <span
          key={pattern}
          className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground"
        >
          <code>{pattern}</code>
          <button
            type="button"
            onClick={() => onRemove(pattern)}
            className="ml-0.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Remove ${pattern}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        placeholder="Add pattern…"
        className="h-6 rounded-full border border-input bg-transparent px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            const input = e.target as HTMLInputElement;
            const val = input.value.trim();
            if (val) onAdd(val);
            input.value = "";
          }
        }}
      />
    </div>
  );
}
