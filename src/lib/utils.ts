import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// A server action that calls redirect() rejects on the client with a sentinel
// error even though navigation succeeds — don't surface it as a failure.
export function isNextRedirectError(err: unknown) {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    String((err as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")
  );
}
