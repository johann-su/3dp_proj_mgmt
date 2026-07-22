// Sidebar order for the operator docs site (built from this directory by the
// standalone Nextra app in ../nextra — see nextra/next.config.mjs).
const meta = {
  index: "Introduction",
  features: "Features",
  "self-hosting": "Self-hosting",
  configuration: "Configuration",
  sso: "OIDC single sign-on",
  roles: "User roles",
  integrations: "Integrations",
  development: "Development",
  "api-reference": "API reference",
  // Dev/agent architecture notes (see AGENTS.md), not operator docs. Hidden
  // here, and nextra/app/[[...mdxPath]]/page.tsx drops the routes from the
  // static export entirely.
  architecture: { display: "hidden" },
};

export default meta;
