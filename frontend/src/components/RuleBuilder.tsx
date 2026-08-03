import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Toggle } from "@/components/ui/toggle";
import { SettingRow } from "@/components/ui/setting-row";
import { useI18n } from "@/i18n/I18nContext";
import type {
  Config,
  NumericOperator,
  RouteRule,
  RuleCondition,
  RuleSet,
  TagRule,
} from "@/types/api";

type RuleKind = "tag" | "route";
type ConditionType = RuleCondition["type"];

interface RuleForm {
  editingId: string | null;
  kind: RuleKind;
  name: string;
  enabled: boolean;
  priority: string;
  conditionType: ConditionType;
  operator: NumericOperator;
  value: string;
  width: string;
  height: string;
  action: string;
}

const EMPTY_FORM: RuleForm = {
  editingId: null,
  kind: "tag",
  name: "",
  enabled: true,
  priority: "0",
  conditionType: "extension",
  operator: "eq",
  value: "",
  width: "",
  height: "",
  action: "",
};

function routeIsSafe(value: string): boolean {
  if (
    !value ||
    value !== value.trim() ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("//")) return false;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  return value
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        !part.endsWith(".") &&
        !part.endsWith(" ") &&
        !reserved.test(part) &&
        !/[<>:"|?*]/.test(part),
    );
}

function makeCondition(form: RuleForm): RuleCondition | null {
  if (form.conditionType === "extension") {
    const value = form.value.trim().replace(/^\./, "").toLocaleLowerCase();
    return value ? { type: "extension", value } : null;
  }
  if (form.conditionType === "filename_contains") {
    return form.value.trim() ? { type: "filename_contains", value: form.value } : null;
  }
  if (form.conditionType === "size") {
    const value = Number(form.value);
    return Number.isInteger(value) && value >= 0
      ? { type: "size", operator: form.operator, value }
      : null;
  }
  const width = Number(form.width);
  const height = Number(form.height);
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { type: "resolution", operator: form.operator, width, height }
    : null;
}

function conditionForm(
  condition: RuleCondition,
): Pick<RuleForm, "conditionType" | "operator" | "value" | "width" | "height"> {
  if (condition.type === "resolution") {
    return {
      conditionType: condition.type,
      operator: condition.operator,
      value: "",
      width: String(condition.width),
      height: String(condition.height),
    };
  }
  return {
    conditionType: condition.type,
    operator: "operator" in condition ? condition.operator : "eq",
    value: String(condition.value),
    width: "",
    height: "",
  };
}

export function RuleBuilderInline({
  config,
  updateConfig,
}: {
  config: Config;
  updateConfig: (patch: Partial<Config>) => void;
}) {
  const { t, locale } = useI18n();
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const ruleSet = useMemo<RuleSet>(
    () => config.rule_set ?? { version: 1, tag_rules: [], route_rules: [] },
    [config.rule_set],
  );
  const rules = useMemo(
    () => [
      ...ruleSet.tag_rules.map((rule) => ({ kind: "tag" as const, rule })),
      ...ruleSet.route_rules.map((rule) => ({ kind: "route" as const, rule })),
    ],
    [ruleSet],
  );

  const saveRuleSet = (next: RuleSet) => updateConfig({ rule_set: next });
  const replaceCollection = (kind: RuleKind, collection: TagRule[] | RouteRule[]) => {
    saveRuleSet({
      ...ruleSet,
      ...(kind === "tag" ? { tag_rules: collection as TagRule[] } : {}),
      ...(kind === "route" ? { route_rules: collection as RouteRule[] } : {}),
    });
  };

  const startNew = () => {
    const maxPriority = Math.max(-1, ...rules.map(({ rule }) => rule.priority));
    setForm({ ...EMPTY_FORM, priority: String(maxPriority + 1) });
    setSubmitted(false);
    setShowForm(true);
  };

  const startEdit = (kind: RuleKind, rule: TagRule | RouteRule) => {
    setForm({
      editingId: rule.id,
      kind,
      name: rule.name,
      enabled: rule.enabled,
      priority: String(rule.priority),
      ...conditionForm(rule.condition),
      action: kind === "tag" ? (rule as TagRule).tag : (rule as RouteRule).relative_folder,
    });
    setSubmitted(false);
    setShowForm(true);
  };

  const validation = useMemo(() => {
    const condition = makeCondition(form);
    return {
      name: !form.name.trim() ? t("rules.nameRequired") : null,
      condition:
        condition === null
          ? form.conditionType === "size"
            ? t("rules.valueNumber")
            : form.conditionType === "resolution"
              ? t("rules.valueResolution")
              : t("rules.valueRequired")
          : null,
      action: !form.action.trim()
        ? t("rules.actionRequired")
        : form.kind === "route" && !routeIsSafe(form.action)
          ? t("rules.routeUnsafe")
          : null,
      priority:
        !Number.isInteger(Number(form.priority)) || Number(form.priority) < 0
          ? t("config.validation.invalid")
          : null,
    };
  }, [form, t]);

  const submit = () => {
    setSubmitted(true);
    if (Object.values(validation).some(Boolean)) return;
    const condition = makeCondition(form);
    if (!condition) return;
    const id = form.editingId ?? `rule-${Date.now()}`;
    const base = {
      id,
      name: form.name.trim(),
      enabled: form.enabled,
      priority: Number(form.priority),
      condition,
    };
    if (form.kind === "tag") {
      const rule: TagRule = { ...base, tag: form.action };
      const next = form.editingId
        ? ruleSet.tag_rules.map((item) => (item.id === id ? rule : item))
        : [...ruleSet.tag_rules, rule];
      replaceCollection("tag", next);
    } else {
      const rule: RouteRule = { ...base, relative_folder: form.action };
      const next = form.editingId
        ? ruleSet.route_rules.map((item) => (item.id === id ? rule : item))
        : [...ruleSet.route_rules, rule];
      replaceCollection("route", next);
    }
    setShowForm(false);
    setForm(EMPTY_FORM);
    setSubmitted(false);
  };

  const mutateRule = (
    kind: RuleKind,
    id: string,
    update: (rule: TagRule | RouteRule) => TagRule | RouteRule,
  ) => {
    const collection = kind === "tag" ? ruleSet.tag_rules : ruleSet.route_rules;
    replaceCollection(
      kind,
      collection.map((rule) => (rule.id === id ? update(rule) : rule)) as TagRule[] | RouteRule[],
    );
  };

  const deleteRule = (kind: RuleKind, id: string) => {
    const collection = kind === "tag" ? ruleSet.tag_rules : ruleSet.route_rules;
    replaceCollection(kind, collection.filter((rule) => rule.id !== id) as TagRule[] | RouteRule[]);
  };

  const moveRule = (kind: RuleKind, index: number, offset: -1 | 1) => {
    const collection = [...(kind === "tag" ? ruleSet.tag_rules : ruleSet.route_rules)] as (
      | TagRule
      | RouteRule
    )[];
    const target = index + offset;
    if (target < 0 || target >= collection.length) return;
    [collection[index], collection[target]] = [collection[target], collection[index]];
    replaceCollection(kind, collection as TagRule[] | RouteRule[]);
  };

  const describeCondition = (condition: RuleCondition): string => {
    const operator = t(`rules.operator.${"operator" in condition ? condition.operator : "eq"}`);
    if (condition.type === "extension")
      return t("rules.describe.extension", { value: condition.value });
    if (condition.type === "filename_contains")
      return t("rules.describe.filename", { value: condition.value });
    if (condition.type === "size")
      return t("rules.describe.size", {
        operator,
        value: new Intl.NumberFormat(locale).format(condition.value),
      });
    return t("rules.describe.resolution", {
      operator,
      value: `${condition.width}×${condition.height}`,
    });
  };

  const renderCollection = (kind: RuleKind, collection: (TagRule | RouteRule)[]) =>
    collection.map((rule, index) => (
      <div key={rule.id} className="rounded-lg border border-border px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{rule.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {describeCondition(rule.condition)} →{" "}
              <span className="font-mono font-semibold">
                {kind === "tag" ? (rule as TagRule).tag : (rule as RouteRule).relative_folder}
              </span>
              {" · "}
              {t(`rules.kind.${kind}`)} · {t("rules.priority")} {rule.priority}
            </p>
          </div>
          <Toggle
            checked={rule.enabled}
            onChange={(enabled) => mutateRule(kind, rule.id, (item) => ({ ...item, enabled }))}
            label={`${t("rules.enabled")}: ${rule.name}`}
          />
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={index === 0}
              onClick={() => moveRule(kind, index, -1)}
              aria-label={`${t("rules.moveUp")}: ${rule.name}`}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={index === collection.length - 1}
              onClick={() => moveRule(kind, index, 1)}
              aria-label={`${t("rules.moveDown")}: ${rule.name}`}
            >
              ↓
            </Button>
            <Button variant="ghost" size="sm" onClick={() => startEdit(kind, rule)}>
              {t("common.edit")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => deleteRule(kind, rule.id)}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {t("common.delete")}
            </Button>
          </div>
        </div>
      </div>
    ));

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-info/20 bg-info/10 p-3 text-xs text-info">
        <strong>{t("rules.title")}</strong> {t("rules.explanation")}
        <div className="mt-1 font-mono">{t("rules.example")}</div>
      </div>
      <SettingRow label={t("rules.enable")} htmlFor="rules-enabled" last>
        <Toggle
          id="rules-enabled"
          checked={config.rules_enabled}
          onChange={(rules_enabled) => updateConfig({ rules_enabled })}
        />
      </SettingRow>
      {config.rules_enabled && (
        <>
          {rules.length === 0 && <p className="text-sm text-muted-foreground">{t("rules.none")}</p>}
          {renderCollection("tag", ruleSet.tag_rules)}
          {renderCollection("route", ruleSet.route_rules)}
          {showForm ? (
            <div className="space-y-3 rounded-lg border border-info/20 bg-info/10 p-4">
              <p className="text-sm font-medium text-info">{t("rules.new")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="rule-kind">{t("rules.kind")}</Label>
                  <Select
                    id="rule-kind"
                    value={form.kind}
                    disabled={form.editingId !== null}
                    onValueChange={(value) => setForm({ ...form, kind: value as RuleKind })}
                  >
                    <SelectItem value="tag">{t("rules.kind.tag")}</SelectItem>
                    <SelectItem value="route">{t("rules.kind.route")}</SelectItem>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rule-name">{t("rules.name")}</Label>
                  <Input
                    id="rule-name"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    placeholder={t("rules.namePlaceholder")}
                  />
                  {submitted && validation.name && (
                    <p className="text-xs text-destructive">{validation.name}</p>
                  )}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="rule-condition">{t("rules.condition")}</Label>
                  <Select
                    id="rule-condition"
                    value={form.conditionType}
                    onValueChange={(value) =>
                      setForm({ ...form, conditionType: value as ConditionType })
                    }
                  >
                    <SelectItem value="extension">{t("rules.condition.extension")}</SelectItem>
                    <SelectItem value="filename_contains">
                      {t("rules.condition.filename")}
                    </SelectItem>
                    <SelectItem value="size">{t("rules.condition.size")}</SelectItem>
                    <SelectItem value="resolution">{t("rules.condition.resolution")}</SelectItem>
                  </Select>
                </div>
                {(form.conditionType === "size" || form.conditionType === "resolution") && (
                  <div className="space-y-1">
                    <Label htmlFor="rule-operator">{t("rules.operator")}</Label>
                    <Select
                      id="rule-operator"
                      value={form.operator}
                      onValueChange={(value) =>
                        setForm({ ...form, operator: value as NumericOperator })
                      }
                    >
                      {(["eq", "gt", "lt", "gte", "lte"] as const).map((operator) => (
                        <SelectItem key={operator} value={operator}>
                          {t(`rules.operator.${operator}`)}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>
                )}
                {form.conditionType === "resolution" ? (
                  <div className="flex gap-2">
                    <Input
                      aria-label={t("rules.width")}
                      type="number"
                      min={1}
                      value={form.width}
                      onChange={(event) => setForm({ ...form, width: event.target.value })}
                    />
                    <Input
                      aria-label={t("rules.height")}
                      type="number"
                      min={1}
                      value={form.height}
                      onChange={(event) => setForm({ ...form, height: event.target.value })}
                    />
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Label htmlFor="rule-value">{t("rules.value")}</Label>
                    <Input
                      id="rule-value"
                      type={form.conditionType === "size" ? "number" : "text"}
                      min={form.conditionType === "size" ? 0 : undefined}
                      value={form.value}
                      onChange={(event) => setForm({ ...form, value: event.target.value })}
                    />
                  </div>
                )}
              </div>
              {submitted && validation.condition && (
                <p className="text-xs text-destructive">{validation.condition}</p>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="rule-action">
                    {t(form.kind === "tag" ? "rules.action.tag" : "rules.action.route")}
                  </Label>
                  <Input
                    id="rule-action"
                    value={form.action}
                    onChange={(event) => setForm({ ...form, action: event.target.value })}
                    placeholder={form.kind === "route" ? "screenshot/mobile" : "Screenshot"}
                  />
                  {submitted && validation.action && (
                    <p className="text-xs text-destructive">{validation.action}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rule-priority">{t("rules.priority")}</Label>
                  <Input
                    id="rule-priority"
                    type="number"
                    min={0}
                    value={form.priority}
                    onChange={(event) => setForm({ ...form, priority: event.target.value })}
                  />
                </div>
              </div>
              <SettingRow label={t("rules.enabled")} htmlFor="rule-enabled" last>
                <Toggle
                  id="rule-enabled"
                  checked={form.enabled}
                  onChange={(enabled) => setForm({ ...form, enabled })}
                />
              </SettingRow>
              <div className="flex gap-2">
                <Button size="sm" onClick={submit}>
                  {form.editingId ? t("rules.save") : t("rules.add")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={startNew}>
              + {t("rules.add")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
