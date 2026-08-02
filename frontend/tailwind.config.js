/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        // Third text level, one step quieter than muted-foreground: counts,
        // units, row meta. Still AA against every surface it is used on.
        faint: "hsl(var(--faint))",
        // The design's undimmed orange. Decoration only — rules, bars, dots,
        // selected borders. Text and text-bearing fills use `primary`.
        brand: "hsl(var(--brand))",
        // Soft status washes for badges and callouts.
        tint: {
          primary: "hsl(var(--tint-primary))",
          success: "hsl(var(--tint-success))",
          warning: "hsl(var(--tint-warning))",
          error: "hsl(var(--tint-error))",
        },
        // Semantic status colours (theme-aware via CSS vars in index.css).
        success: "hsl(var(--color-success))",
        warning: "hsl(var(--color-warning))",
        error: "hsl(var(--color-error))",
        info: "hsl(var(--color-info))",
        category: {
          DEFAULT: "hsl(var(--color-category))",
          foreground: "hsl(var(--color-category-foreground))",
        },
        // Categorical series for charts. Named rather than raw palette values
        // so an n-way breakdown is not mistaken for status colouring.
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
          6: "hsl(var(--chart-6))",
        },
        // The log console's fixed dark chrome, in both themes.
        console: {
          DEFAULT: "hsl(var(--console-surface))",
          border: "hsl(var(--console-border))",
          foreground: "hsl(var(--console-text))",
          muted: "hsl(var(--console-muted))",
        },
      },
      // Tailwind's scale stops at text-xs (12px), and this is a dense tool that
      // genuinely needs two steps below it for badges, counts and table meta.
      // Without them every such place reached for `text-[11px]`, which is how
      // 100 arbitrary type values ended up spread across 26 files.
      //
      // Two steps, not three: the former `text-[9px]` sites were all small count
      // badges, and 9px is below a sensible legibility floor for a tool someone
      // reads all day. They use `text-3xs`.
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        "3xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Geist Sans", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        // The one card elevation the design uses, warm and downward.
        card: "var(--shadow-card)",
      },
    },
  },
  plugins: [],
};
