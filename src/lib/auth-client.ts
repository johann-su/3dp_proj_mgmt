import { createAuthClient } from "better-auth/react";

// Generic OIDC providers are registered as social providers server-side (better-auth ≥ 1.7), so the SSO button goes through signIn.social and the client needs no plugin for it.
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
