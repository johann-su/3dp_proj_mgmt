// Without this, Next.js's postcss config lookup walks up past this
// directory and picks up the repo root's postcss.config.mjs (meant for the
// main app's Tailwind build), requiring `@tailwindcss/postcss` — a package
// nextra/package.json never declares. That only "worked" on machines that
// happen to have the root app's node_modules installed alongside this one;
// a standalone checkout (CI, Docker) doesn't. The only CSS this app imports
// (nextra-theme-docs/style.css) is already fully compiled — no plugins needed.
const config = {
  plugins: {},
};

export default config;
