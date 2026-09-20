import type { Config } from "tailwindcss";

const token = (name: string) => `oklch(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: token("canvas"),
        rail: token("rail"),
        panel: token("panel"),
        elevated: token("elevated"),
        ink: token("ink"),
        muted: token("muted"),
        faint: token("faint"),
        line: token("line"),
        accent: token("accent"),
        "accent-ink": token("accent-ink"),
        info: token("info"),
        success: token("success"),
        warning: token("warning"),
        danger: token("danger")
      },
      fontFamily: {
        heading: ["Outfit", "sans-serif"],
        sans: ["IBM Plex Sans", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"]
      },
      boxShadow: {
        instrument: "0 12px 28px -18px oklch(var(--shadow) / 0.46)",
        drawer: "-12px 0 34px -24px oklch(var(--shadow) / 0.58)"
      },
      borderRadius: {
        control: "10px",
        panel: "14px"
      },
      keyframes: {
        "trace-pulse": {
          "0%, 100%": { opacity: "0.58" },
          "50%": { opacity: "1" }
        }
      },
      animation: {
        "trace-pulse": "trace-pulse 1.8s ease-in-out infinite"
      }
    }
  },
  plugins: []
} satisfies Config;
