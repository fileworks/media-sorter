import { RuleBuilderInline } from "@/components/RuleBuilder";
import type { SectionProps } from "@/components/config/constants";

export function RulesSection({ config, updateConfig }: SectionProps) {
  return <RuleBuilderInline config={config} updateConfig={updateConfig} />;
}
