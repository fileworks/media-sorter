import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuleBuilderInline } from "@/components/RuleBuilder";
import { I18nProvider } from "@/i18n/I18nContext";
import type { Config } from "@/types/api";

describe("localized typed rule controls", () => {
  it("renders German application text while preserving user-entered values", () => {
    const config = {
      rules_enabled: true,
      rule_set: {
        version: 1,
        tag_rules: [
          {
            id: "family",
            name: "Family originals",
            enabled: true,
            priority: 10,
            condition: { type: "extension", value: "jpg" },
            tag: "Family",
          },
        ],
        route_rules: [
          {
            id: "screenshots",
            name: "Phone screenshots",
            enabled: true,
            priority: 0,
            condition: { type: "filename_contains", value: "ScreenShot" },
            relative_folder: "screenshots/mobile",
          },
        ],
      },
    } as Config;

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <RuleBuilderInline config={config} updateConfig={() => undefined} />
      </I18nProvider>,
    );

    expect(html).toContain("Deterministische Regeln");
    expect(html).toContain("Routenregel");
    expect(html).toContain("Family originals");
    expect(html).toContain("Family");
    expect(html).toContain("screenshots/mobile");
    expect(html).not.toContain("Familie");
  });
});
