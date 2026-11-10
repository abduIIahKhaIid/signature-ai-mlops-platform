/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#16245A", soft: "#3A4775", faint: "#6B7493" },
        desk: { DEFAULT: "#E6EAF0", deep: "#D5DBE4", line: "#C3CBD7" },
        paper: "#FFFFFF",
        marker: { DEFAULT: "#D6245F", soft: "#FBE3EB" },
        verified: { DEFAULT: "#11815A", soft: "#DDF2E8" },
        caution: { DEFAULT: "#B26B00", soft: "#FBEBD0" },
        fault: { DEFAULT: "#C0352B", soft: "#FADFDC" },
        signal: { DEFAULT: "#2F5BD3", soft: "#E1E9FB" },
      },
      fontFamily: {
        display: ['"Bricolage Grotesque Variable"', "system-ui", "sans-serif"],
        sans: ['"Instrument Sans Variable"', "system-ui", "sans-serif"],
        code: ['ui-monospace', '"SFMono-Regular"', "Menlo", "monospace"],
      },
      boxShadow: {
        sheet: "0 1px 0 rgba(22,36,90,.06), 0 12px 32px -12px rgba(22,36,90,.28)",
        lift: "0 1px 2px rgba(22,36,90,.08)",
      },
      keyframes: {
        draw: { from: { strokeDashoffset: "var(--len)" }, to: { strokeDashoffset: "0" } },
        tagin: { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } },
        pulsebar: { "0%,100%": { opacity: ".45" }, "50%": { opacity: "1" } },
      },
      animation: {
        draw: "draw .7s cubic-bezier(.6,0,.2,1) both",
        tagin: "tagin .25s ease-out both",
        pulsebar: "pulsebar 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
