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
          hover: "hsl(var(--primary-hover))",
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
        border: {
          DEFAULT: "hsl(var(--border))",
          // The hover edge. Bordered objects darken rather than fill, which is
          // what keeps a hovered row from reading as a selected one.
          strong: "hsl(var(--border-strong))",
        },
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        // Third text level, one step quieter than muted-foreground: counts,
        // units, row meta. Still AA against every surface it is used on.
        faint: "hsl(var(--faint))",
        // The undimmed accents. Decoration only — rules, bars, dots, selected
        // borders. Text and text-bearing fills use primary/success/warning.
        brand: "hsl(var(--brand))",
        decor: {
          success: "hsl(var(--decor-success))",
          warning: "hsl(var(--decor-warning))",
        },
        // Soft status washes for badges and callouts.
        tint: {
          primary: "hsl(var(--tint-primary))",
          success: "hsl(var(--tint-success))",
          warning: "hsl(var(--tint-warning))",
          error: "hsl(var(--tint-error))",
          // Informational callouts use the same semantic/token pairing as the
          // other status tints. Keeping it here prevents a raw-blue fallback
          // from creeping into the review selection surface.
          info: "hsl(var(--tint-info))",
        },
        // A quiet raised panel. This deliberately aliases the neutral surface
        // token instead of introducing a sixth near-identical grey.
        surface: {
          muted: "hsl(var(--surface-muted))",
          // One step below `muted`, for the well a compared image sits in.
          sunken: "hsl(var(--surface-sunken))",
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
        xs: ["0.8125rem", { lineHeight: "1.125rem" }],
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        "3xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        // Two radii the mockup uses that do not fall out of `--radius`:
        // interactive controls are tighter than the cards they sit in (7px),
        // and panels nested inside a card sit between the two (8px). Naming
        // them stops every control reaching for an arbitrary `rounded-[7px]`.
        control: "7px",
        panel: "8px",
      },
      fontFamily: {
        sans: ["Geist Sans", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      // Named shell geometry keeps the fixed rails and centered workspace in
      // sync. These values come directly from mediasorter-final.html.
      height: {
        titlebar: "3.375rem", // 54px
        stepper: "4.25rem", // 68px at tablet widths
        "stepper-wide": "4.75rem", // 76px on a full desktop
      },
      minHeight: {
        actionbar: "3.75rem", // 60px
      },
      maxWidth: {
        workspace: "92.5rem", // 1480px
      },
      boxShadow: {
        // The one card elevation the design uses, warm and downward.
        card: "var(--shadow-card)",
      },
    },
  },
  plugins: [],
};
