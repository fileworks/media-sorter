import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Toggle } from "@/components/ui/toggle";
import { FormRow } from "@/components/ui/form-row";
import { cn } from "@/lib/utils";
import type { Rule, Config } from "@/types/api";

// ── Types ──────────────────────────────────────────────────────────────────────

type ConditionType = "extension" | "filename_contains" | "size" | "resolution";
type Operator = "eq" | "gt" | "lt" | "gte" | "lte";

interface NewRuleForm {
  name: string;
  conditionType: ConditionType;
  operator: Operator;
  conditionValue: string;
  tag: string;
}

interface FormErrors {
  name?: string;
  conditionValue?: string;
  tag?: string;
}

const EMPTY_FORM: NewRuleForm = {
  name: "",
  conditionType: "extension",
  operator: "eq",
  conditionValue: "",
  tag: "",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

const OP_LABEL: Record<Operator, string> = {
  eq: "is",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
};

function describeCondition(condition: Record<string, unknown>): string {
  const type = String(condition.type ?? "");
  const op = String(condition.operator ?? "eq") as Operator;
  const value = String(condition.value ?? "");
  const opLabel = OP_LABEL[op] ?? op;

  switch (type) {
    case "extension":
      return `Extension is .${value.replace(/^\./, "")}`;
    case "size": {
      const bytes = Number(value);
      const display = isNaN(bytes)
        ? value
        : bytes >= 1_048_576
          ? `${(bytes / 1_048_576).toFixed(0)} MB`
          : bytes >= 1024
            ? `${(bytes / 1024).toFixed(0)} KB`
            : `${bytes} B`;
      return `File size ${opLabel} ${display}`;
    }
    case "filename_contains":
    case "filename":
      return `Filename contains "${value}"`;
    case "resolution":
      return `Resolution ${opLabel} ${value}`;
    default:
      return JSON.stringify(condition);
  }
}

/** Validate a rule form and return field-level error messages. */
function validateForm(form: NewRuleForm): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) {
    errors.name = "Rule name is required";
  }
  if (!form.conditionValue.trim()) {
    if (form.conditionType === "extension") {
      errors.conditionValue = "Enter a file extension (e.g. jpg)";
    } else if (form.conditionType === "size") {
      errors.conditionValue = "Enter a file size in bytes (e.g. 10485760)";
    } else if (form.conditionType === "resolution") {
      errors.conditionValue = "Enter a resolution (e.g. 3840x2160)";
    } else {
      errors.conditionValue = "Enter a value to match";
    }
  } else if (form.conditionType === "size" && isNaN(Number(form.conditionValue))) {
    errors.conditionValue = "File size must be a number (bytes)";
  }
  if (!form.tag.trim()) {
    errors.tag = "Tag is required";
  }
  return errors;
}

// ── Inline component (used inside ConfigPanel) ─────────────────────────────────

interface RuleBuilderInlineProps {
  config: Config;
  updateConfig: (patch: Partial<Config>) => void;
}

export function RuleBuilderInline({ config, updateConfig }: RuleBuilderInlineProps) {
  const [form, setForm] = useState<NewRuleForm>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [touched, setTouched] = useState(false);

  const rules: Rule[] = config.rules ?? [];

  const deleteRule = (id: string) => {
    updateConfig({ rules: rules.filter((r) => r.id !== id) });
  };

  const addRule = () => {
    setTouched(true);
    const errors = validateForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const needsOperator = form.conditionType === "size" || form.conditionType === "resolution";

    const newRule: Rule = {
      id: `rule_${Date.now()}`,
      name: form.name.trim(),
      condition: {
        type: form.conditionType,
        ...(needsOperator ? { operator: form.operator } : {}),
        value:
          form.conditionType === "size" ? Number(form.conditionValue) : form.conditionValue.trim(),
      },
      tag: form.tag.trim(),
    };

    updateConfig({ rules: [...rules, newRule] });
    setForm(EMPTY_FORM);
    setFormErrors({});
    setTouched(false);
    setShowForm(false);
  };

  const setField = <K extends keyof NewRuleForm>(key: K, value: NewRuleForm[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    // Re-validate on change once user has attempted submission
    if (touched) {
      setFormErrors(validateForm(next));
    }
  };

  const needsOperator = form.conditionType === "size" || form.conditionType === "resolution";

  return (
    <div className="space-y-3">
      {/* Explanation banner */}
      <div className="rounded-md bg-info/10 p-3 text-xs text-info border border-info/20">
        <strong>Rule-based tagging</strong> lets you automatically label files so they appear tagged
        in the sort report. Rules don't change where a file is sorted — they add metadata tags like{" "}
        <code className="mx-1 font-mono">4K</code> or <code className="mx-1 font-mono">RAW</code>{" "}
        visible in the preview and report.
        <br />
        <strong>Example:</strong> tag all files with resolution &gt; 3840×2160 as{" "}
        <code className="ml-1 font-mono">4K</code>.
      </div>

      {/* Enable rules toggle */}
      <FormRow label="Enable rules" htmlFor="rules-enabled" inline={true}>
        <Toggle
          id="rules-enabled"
          checked={config.rules_enabled}
          onChange={(v) => updateConfig({ rules_enabled: v })}
        />
      </FormRow>

      {config.rules_enabled && (
        <>
          {rules.length === 0 && (
            <p className="text-sm text-muted-foreground">No rules defined yet.</p>
          )}

          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{rule.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {describeCondition(rule.condition)} →{" "}
                  <span className="font-mono font-semibold">{rule.tag}</span>
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteRule(rule.id)}
                className="ml-2 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Delete
              </Button>
            </div>
          ))}

          {showForm ? (
            <div className="space-y-3 rounded-lg border border-info/20 bg-info/10 p-4">
              <p className="text-sm font-medium text-info">New Rule</p>

              {/* Rule name */}
              <div className="space-y-1">
                <Label htmlFor="rule-name">Rule name</Label>
                <Input
                  id="rule-name"
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  placeholder="e.g. 4K Videos"
                  className={formErrors.name ? "border-destructive focus:ring-destructive/30" : ""}
                />
                {formErrors.name && <p className="text-xs text-destructive">{formErrors.name}</p>}
              </div>

              {/* Condition type + optional operator + value */}
              <div className={`grid gap-3 ${needsOperator ? "grid-cols-3" : "grid-cols-2"}`}>
                <div className="space-y-1">
                  <Label htmlFor="rule-condition">Condition</Label>
                  <Select
                    id="rule-condition"
                    value={form.conditionType}
                    onValueChange={(v) => setField("conditionType", v as ConditionType)}
                  >
                    <SelectItem value="extension">Extension</SelectItem>
                    <SelectItem value="filename_contains">Filename contains</SelectItem>
                    <SelectItem value="size">File size</SelectItem>
                    <SelectItem value="resolution">Resolution</SelectItem>
                  </Select>
                </div>

                {needsOperator && (
                  <div className="space-y-1">
                    <Label htmlFor="rule-operator">Operator</Label>
                    <Select
                      id="rule-operator"
                      value={form.operator}
                      onValueChange={(v) => setField("operator", v as Operator)}
                    >
                      <SelectItem value="eq">is equal to</SelectItem>
                      <SelectItem value="gt">greater than</SelectItem>
                      <SelectItem value="lt">less than</SelectItem>
                      <SelectItem value="gte">at least</SelectItem>
                      <SelectItem value="lte">at most</SelectItem>
                    </Select>
                  </div>
                )}

                <div className="space-y-1">
                  <Label htmlFor="rule-value">Value</Label>
                  <Input
                    id="rule-value"
                    value={form.conditionValue}
                    onChange={(e) => setField("conditionValue", e.target.value)}
                    placeholder={
                      form.conditionType === "extension"
                        ? "jpg"
                        : form.conditionType === "size"
                          ? "bytes, e.g. 10485760"
                          : form.conditionType === "resolution"
                            ? "e.g. 3840x2160"
                            : "e.g. holiday"
                    }
                    className={
                      formErrors.conditionValue
                        ? "border-destructive focus:ring-destructive/30"
                        : ""
                    }
                  />
                  {formErrors.conditionValue && (
                    <p className="text-xs text-destructive">{formErrors.conditionValue}</p>
                  )}
                </div>
              </div>

              {/* Tag */}
              <div className="space-y-1">
                <Label htmlFor="rule-tag">Tag</Label>
                <Input
                  id="rule-tag"
                  value={form.tag}
                  onChange={(e) => setField("tag", e.target.value)}
                  placeholder="e.g. 4K"
                  className={cn(
                    "max-w-xs",
                    formErrors.tag ? "border-destructive focus:ring-destructive/30" : "",
                  )}
                />
                {formErrors.tag && <p className="text-xs text-destructive">{formErrors.tag}</p>}
              </div>

              <div className="flex gap-2">
                <Button size="sm" onClick={addRule}>
                  Add Rule
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowForm(false);
                    setForm(EMPTY_FORM);
                    setFormErrors({});
                    setTouched(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
              + Add Rule
            </Button>
          )}
        </>
      )}
    </div>
  );
}
