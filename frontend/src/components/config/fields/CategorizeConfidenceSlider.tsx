export function CategorizeConfidenceSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const pct = Math.round(value * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">More sorted (50%)</span>
        <span className="font-mono text-foreground">{pct}%</span>
        <span className="text-muted-foreground">Only when sure (99%)</span>
      </div>
      <input
        type="range"
        min={50}
        max={99}
        value={pct}
        onChange={(e) => onChange(Math.min(99, Math.max(50, Number(e.target.value))) / 100)}
        className="w-full accent-primary"
      />
      <p className="text-xs text-muted-foreground">
        Files below this confidence go to <code>_uncategorized/</code>.
      </p>
    </div>
  );
}
