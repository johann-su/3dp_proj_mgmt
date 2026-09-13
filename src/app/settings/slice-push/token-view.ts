// The serializable shape of a push token as it crosses to the client. Kept out
// of push-actions.ts because a "use server" module may only export async
// functions — a plain converter there is a build error, not a lint nit.

import type { PushTokenSummary } from "@/lib/push-tokens";

// Dates cross the server/client boundary as ISO strings.
export type PushTokenView = Omit<
  PushTokenSummary,
  "createdAt" | "lastUsedAt"
> & {
  createdAt: string;
  lastUsedAt: string | null;
};

export function toPushTokenView(token: PushTokenSummary): PushTokenView {
  return {
    ...token,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  };
}
