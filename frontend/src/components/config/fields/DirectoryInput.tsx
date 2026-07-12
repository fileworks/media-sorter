import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FiX } from "react-icons/fi";

export function DirectoryInput({
  id,
  value,
  placeholder,
  invalid = false,
  onCommit,
  onBrowse,
}: {
  id: string;
  value: string;
  placeholder: string;
  invalid?: boolean;
  onCommit: (v: string) => void;
  onBrowse: () => void;
}) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setLocal(value);
  }, [value]);

  return (
    <div className="flex gap-2">
      <div
        className={cn(
          "flex flex-1 min-w-0 items-center gap-1 rounded-md border bg-background px-3 py-2 text-sm overflow-hidden",
          invalid
            ? "border-error focus-within:border-error focus-within:ring-1 focus-within:ring-error"
            : "border-input focus-within:border-ring focus-within:ring-1 focus-within:ring-ring",
        )}
      >
        <input
          id={id}
          type="text"
          value={local}
          aria-invalid={invalid || undefined}
          className="flex-1 min-w-0 bg-transparent font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
          placeholder={placeholder}
          onChange={(e) => setLocal(e.target.value)}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={(e) => {
            focused.current = false;
            onCommit(e.target.value);
          }}
        />
        {local && (
          <button
            type="button"
            onClick={() => {
              setLocal("");
              onCommit("");
            }}
            className="ml-1 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Clear folder"
          >
            <FiX className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={onBrowse}>
        Browse
      </Button>
    </div>
  );
}
