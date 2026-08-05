import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        surface: {
          DEFAULT: "hsl(var(--surface) / <alpha-value>)",
          muted: "hsl(var(--surface-muted) / <alpha-value>)",
        },
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        "muted-foreground": "hsl(var(--muted-foreground) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        action: {
          DEFAULT: "hsl(var(--action) / <alpha-value>)",
          foreground: "hsl(var(--action-foreground) / <alpha-value>)",
        },
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        danger: "hsl(var(--danger) / <alpha-value>)",
        info: "hsl(var(--info) / <alpha-value>)",
      },
      /* Extended, not nested under `colors.border` — nesting there would spell
         the utility `border-border-strong`. This keeps it `border-strong` while
         leaving every colour-derived border utility intact. */
      borderColor: {
        strong: "hsl(var(--border-strong) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-plex-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-plex-mono)", "ui-monospace", "monospace"],
      },
      // The pack's chrome runs smaller than Tailwind's defaults: 9–10px mono
      // labels against 11.5–13.5px body. Added rather than rebasing the scale,
      // so existing sizes keep meaning what they meant.
      fontSize: {
        "2xs": "0.625rem",   /* 10px — mono labels, count badges  */
        "3xs": "0.5625rem",  /*  9px — sidebar section headings   */
      },
    },
    /* Square, not rounded. Overriding the scale beats editing every
       `rounded-*` in the codebase — and stops the next one creeping back in. */
    borderRadius: {
      none: "0", sm: "0", DEFAULT: "0", md: "0", lg: "0",
      xl: "0", "2xl": "0", "3xl": "0", full: "0",
    },
    /* The pack uses exactly one shadow, on the outermost frame. */
    boxShadow: {
      none: "none",
      sm: "0 1px 2px rgba(20, 23, 26, 0.06)",
      DEFAULT: "0 1px 3px rgba(20, 23, 26, 0.08)",
      md: "0 1px 3px rgba(20, 23, 26, 0.08)",
      lg: "0 2px 6px rgba(20, 23, 26, 0.10)",
      xl: "0 2px 6px rgba(20, 23, 26, 0.10)",
      inner: "inset 0 1px 2px rgba(20, 23, 26, 0.06)",
    },
  },
  plugins: [],
} satisfies Config;
