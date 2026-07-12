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
