import { useState, useEffect, type InputHTMLAttributes } from "react";
import { Input } from "@/components/ui/input";

interface BlurCommitInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
> {
  value: string | null | undefined;
  onCommit: (value: string | null) => void;
  emptyValue?: null | "";
}

/**
 * A controlled text input that only fires `onCommit` when the user leaves
 * the field (blur) or presses Enter — not on every keystroke.
 *
 * Use this for settings that would trigger an expensive backend save or a
 * confirmation dialog on every keypress (e.g. API keys, endpoints, sizes).
 */
export function BlurCommitInput({
  value,
  onCommit,
  emptyValue = null,
  ...props
}: BlurCommitInputProps) {
  const [local, setLocal] = useState(value ?? "");

  // Keep in sync when the committed value changes externally (e.g. reset)
  useEffect(() => {
    setLocal(value ?? "");
  }, [value]);

  const commit = () => {
    const trimmed = local.trim();
    onCommit(trimmed === "" ? (emptyValue as null) : trimmed);
  };

  return (
    <Input
      {...props}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
