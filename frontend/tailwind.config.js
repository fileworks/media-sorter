/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: "hsl(var(--card))",
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
        accent: "hsl(var(--accent))",
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: {
          DEFAULT: "hsl(var(--border))",
          // Strong hover edge for bordered controls.
          strong: "hsl(var(--border-strong))",
        },
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        // AA-compliant tertiary text.
        faint: "hsl(var(--faint))",
        // Decorative accents; never use these for text.
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
          // Informational callout tint.
          info: "hsl(var(--tint-info))",
        },
        // Raised neutral panel.
        surface: {
          muted: "hsl(var(--surface-muted))",
        },
        // Semantic status colours (theme-aware via CSS vars in index.css).
        success: "hsl(var(--color-success))",
        warning: "hsl(var(--color-warning))",
        error: "hsl(var(--color-error))",
        info: "hsl(var(--color-info))",
        // Categorical chart series, separate from status colors.
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
          6: "hsl(var(--chart-6))",
        },
      },
      // Named compact type steps avoid arbitrary values below text-xs.
      fontSize: {
        xs: ["0.8125rem", { lineHeight: "1.125rem" }],
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        "3xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        // Named control and nested-panel radii.
        control: "7px",
        panel: "8px",
      },
      fontFamily: {
        sans: ["Geist Sans", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      // Shell geometry from mediasorter-final.html.
      height: {
        titlebar: "3.375rem", // 54px
        stepper: "4.25rem", // 68px at tablet widths
        "stepper-wide": "4.75rem", // 76px on a full desktop
      },
      minHeight: {
        actionbar: "3.75rem", // 60px
      },
      spacing: {
        // The band at the bottom of the viewport that floating controls own:
        // the action bar (3.75rem) plus the selection bar that sits above it,
        // plus breathing room. Anything scrolled into view must clear it and
        // anything floating must sit above it, so the number lives here once.
        actionzone: "8rem",
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
