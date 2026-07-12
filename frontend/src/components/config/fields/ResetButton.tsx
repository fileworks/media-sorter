export function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
    >
      Reset section
    </button>
  );
}
