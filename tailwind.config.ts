import type { Config } from "tailwindcss";

/**
 * Forge palette — warm earthy neutrals with a single accent.
 * Inspired by Nothing Design (stark contrast, reduced ornament)
 * blended with Anthropic-style warm off-white / paper tones.
 * Named via stone metaphor: "stone" scale for neutrals, "ember" for accent.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem", screens: { "2xl": "1400px" } },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        subtle: "hsl(var(--subtle))",
        ember: {
          DEFAULT: "hsl(var(--ember))",
          foreground: "hsl(var(--ember-foreground))",
        },
        success: "hsl(var(--success))",
        warning: "hsl(var(--warning))",
        danger: "hsl(var(--danger))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular"],
      },
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],
        sm: ["0.8125rem", { lineHeight: "1.25rem" }],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(2px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        // Motion — design-spec M1–M10 (see globals.css `/* Motion — forge-* */`).
        // Registered so product code can use `animate-forge-*` utilities; the
        // canonical, reduced-motion-gated definitions live in globals.css.
        "forge-grid-drift": {
          to: {
            backgroundPosition:
              "var(--grid-size) var(--grid-size), var(--grid-size) var(--grid-size)",
          },
        },
        "forge-aurora-drift": {
          "0%": { transform: "translate3d(-2%, -1%, 0) scale(1)", opacity: "0.85" },
          "50%": { transform: "translate3d(2%, 1%, 0) scale(1.05)", opacity: "1" },
          "100%": { transform: "translate3d(1%, -2%, 0) scale(1.02)", opacity: "0.9" },
        },
        "forge-dots-drift": {
          to: { backgroundPosition: "28px 56px" },
        },
        "forge-row-rise": {
          from: { opacity: "0", transform: "translateY(0.25rem)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "forge-stream-sweep": {
          from: { backgroundPosition: "100% 0" },
          to: { backgroundPosition: "-100% 0" },
        },
        "forge-pulse": {
          "0%, 100%": {
            boxShadow:
              "0 0 0 1px hsl(var(--ember) / 0.55) inset, 0 0 0 0 hsl(var(--ember) / 0)",
          },
          "50%": {
            boxShadow:
              "0 0 0 1px hsl(var(--ember) / 0.8) inset, 0 0 0 6px hsl(var(--ember) / 0.1)",
          },
        },
        "forge-caret-blink": {
          "50%": { opacity: "0" },
        },
        "forge-hairline-sweep": {
          "0%, 70%, 100%": { transform: "translateX(-100%)" },
          "85%": { transform: "translateX(100%)" },
        },
        "forge-breath": {
          "0%, 100%": { boxShadow: "0 0 0 0 hsl(var(--success) / 0.4)" },
          "50%": { boxShadow: "0 0 0 5px hsl(var(--success) / 0)" },
        },
        // BG3 glow-grid: two soft lights drifting on non-syncing paths.
        "forge-glow-drift-a": {
          "0%": { transform: "translate3d(-15%, -10%, 0)" },
          "25%": { transform: "translate3d(10%, -18%, 0)" },
          "50%": { transform: "translate3d(18%, 12%, 0)" },
          "75%": { transform: "translate3d(-12%, 16%, 0)" },
          "100%": { transform: "translate3d(-15%, -10%, 0)" },
        },
        "forge-glow-drift-b": {
          "0%": { transform: "translate3d(20%, 15%, 0)" },
          "33%": { transform: "translate3d(-18%, 10%, 0)" },
          "66%": { transform: "translate3d(-10%, -20%, 0)" },
          "100%": { transform: "translate3d(20%, 15%, 0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out",
        shimmer: "shimmer 2s linear infinite",
        "forge-grid-drift": "forge-grid-drift 48s linear infinite",
        "forge-aurora-drift": "forge-aurora-drift 28s ease-in-out infinite alternate",
        "forge-dots-drift": "forge-dots-drift 60s linear infinite",
        "forge-row-rise": "forge-row-rise 220ms ease-out forwards",
        "forge-stream-sweep": "forge-stream-sweep 2.8s linear infinite",
        "forge-pulse": "forge-pulse 2.4s ease-in-out infinite",
        "forge-caret-blink": "forge-caret-blink 1.05s steps(2, start) infinite",
        "forge-hairline-sweep": "forge-hairline-sweep 6s ease-in-out infinite",
        "forge-breath": "forge-breath 3.2s ease-in-out infinite",
        "forge-glow-drift-a": "forge-glow-drift-a 28s linear infinite",
        "forge-glow-drift-b": "forge-glow-drift-b 36s linear infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
