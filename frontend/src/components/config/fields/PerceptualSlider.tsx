export function PerceptualSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const hint =
    value >= 98
      ? "Nearly pixel-perfect — safest, fewest false positives"
      : value >= 93
        ? "Catches re-compressed copies — recommended default"
        : value >= 88
          ? "Catches edited or cropped versions"
          : "⚠ May flag similar-but-different photos as duplicates";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">More lenient (85%)</span>
        <span className="font-mono text-foreground">{value}%</span>
        <span className="text-muted-foreground">Stricter (100%)</span>
      </div>
      <input
        type="range"
        min={85}
        max={100}
        value={value}
        onChange={(e) => onChange(Math.min(100, Math.max(85, Number(e.target.value))))}
        className="w-full accent-primary"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
