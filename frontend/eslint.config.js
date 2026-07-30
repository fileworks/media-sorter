import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Flat config for the Vite + React + TypeScript frontend.
// js/ts recommended rules + React Hooks rules + react-refresh (Fast Refresh)
// safety, with eslint-config-prettier last so formatting is owned by Prettier.
export default tseslint.config(
  { ignores: ["dist", "src-tauri"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The three React Compiler rules that arrived in eslint-plugin-react-hooks
      // v7. The plugin was upgraded because eslint 10 requires it, and eslint 10
      // is what removes the minimatch@3 -> brace-expansion@1 chain behind five
      // high-severity advisories.
      //
      // They are new opinions, not newly discovered defects: they flag 47 places
      // across 15 files, all of which work today —
      //   react-hooks/refs                 24
      //   react-hooks/set-state-in-effect  22
      //   react-hooks/immutability          1
      //
      // Turned off rather than silently downgraded, because `--max-warnings 0`
      // means a warning is a failure here anyway, and a rule nobody can act on
      // is worse than an absent one. Adopting them means reworking render and
      // effect flow in PreviewList, ReviewWorkbench and the preview hooks, which
      // is its own change with its own review — not a rider on a security bump.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Catch the temporal-dead-zone class of bug: a `const`/`let` referenced
      // (e.g. inside a useMemo/useState initialiser that runs during render)
      // before its declaration line. This is exactly the crash that shipped in
      // ConfigPanel ("Cannot access 'sectionFields' before initialization").
      // `functions: false` keeps hoisted function declarations legal; type
      // references are ignored since types are erased.
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": [
        "error",
        {
          functions: false,
          classes: true,
          variables: true,
          enums: true,
          typedefs: false,
          ignoreTypeReferences: true,
        },
      ],
    },
  },
  prettier,
);
