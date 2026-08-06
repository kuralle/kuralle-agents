// Tailwind v4 is required by the AI Elements chat components (`components/ai-elements/*`),
// which ship as Tailwind-utility markup. The rest of the app keeps its hand-written CSS in
// `app/globals.css`; the two coexist because Tailwind only emits utilities that are actually
// used, and this app's own class names (`chat`, `card`, `btn`) are not utility names.
const config = { plugins: { '@tailwindcss/postcss': {} } };
export default config;
