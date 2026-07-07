/** @type {import('tailwindcss').Config} */
export default {
  // Theme is driven by a data-theme attribute on <html> (manual toggle,
  // initialized from prefers-color-scheme). All colors are CSS variables that
  // flip on that attribute, so most components need no `dark:` variant.
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        panel: "var(--panel)",
        surface: { DEFAULT: "var(--surface)", 2: "var(--surface-2)" },
        inset: "var(--inset)",
        line: {
          DEFAULT: "var(--border)",
          2: "var(--border-2)",
          strong: "var(--border-strong)",
        },
        ink: {
          DEFAULT: "var(--fg)",
          2: "var(--fg-2)",
          3: "var(--fg-3)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          2: "var(--accent-2)",
          fg: "var(--accent-fg)",
          soft: "var(--accent-soft)",
          line: "var(--accent-line)",
        },
        // Status token foregrounds (chips/badges also live as component
        // classes in index.css; these expose the same colors to utilities).
        em: { fg: "var(--em-fg)", bg: "var(--em-bg)" },
        rose: { fg: "var(--rose-fg)", bg: "var(--rose-bg)" },
        sky: { fg: "var(--sky-fg)", bg: "var(--sky-bg)" },
        amber: { fg: "var(--amber-fg)", bg: "var(--amber-bg)" },
        violet: { fg: "var(--violet-fg)", bg: "var(--violet-bg)" },
        neutral: { fg: "var(--neutral-fg)", bg: "var(--neutral-bg)" },
      },
      borderColor: { DEFAULT: "var(--border)" },
      fontFamily: {
        sans: "var(--font-ui)",
        ui: "var(--font-ui)",
        display: "var(--font-display)",
        mono: "var(--font-mono)",
      },
      boxShadow: {
        card: "var(--shadow)",
        pop: "var(--shadow-lg)",
      },
      borderRadius: {
        card: "13px",
      },
      keyframes: {
        pulse2: {
          "0%,100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.45", transform: "scale(0.82)" },
        },
        blink: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0" } },
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
        pop: {
          "0%": { opacity: "0", transform: "translateY(4px) scale(0.99)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        pulse2: "pulse2 1.3s ease-in-out infinite",
        blink: "blink 1s step-end infinite",
        pop: "pop 0.2s ease-out",
      },
    },
  },
  plugins: [],
};
