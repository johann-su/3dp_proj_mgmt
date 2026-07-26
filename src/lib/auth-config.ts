// Pure env-flag logic for the auth setup. Kept out of `@/lib/auth` because
// that module opens a DB pool and pings the OIDC discovery endpoint at import
// time, so a unit test can't import it (see AGENTS.md → Testing).

/** `true`/`1`, case- and whitespace-insensitive. Anything else is false. */
export function envFlag(raw: string | undefined): boolean {
  return ["true", "1"].includes(raw?.trim().toLowerCase() ?? "");
}

/**
 * Whether email/password sign-in stays available.
 *
 * `DISABLE_PASSWORD_LOGIN` makes the identity provider the only way in, which
 * is what an internet-facing instance behind Authentik wants: a local password
 * is a second door with no MFA and only BetterAuth's rate limit in front of it.
 *
 * It is deliberately **ignored unless OIDC is configured** — honouring it on an
 * instance with no SSO would leave nobody able to sign in at all, and locking
 * the operator out of their own catalog is worse than the door it closes.
 */
export function passwordLoginEnabled(
  rawDisableFlag: string | undefined,
  oidcEnabled: boolean,
): boolean {
  return !(envFlag(rawDisableFlag) && oidcEnabled);
}
