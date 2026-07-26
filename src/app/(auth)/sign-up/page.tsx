import { redirect } from "next/navigation";
import { passwordLoginDisabled, signupDisabled } from "@/lib/auth";
import { safeCallbackPath, signInPath } from "@/lib/callback-url";
import { SignUpForm } from "./sign-up-form";

export const dynamic = "force-dynamic";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  // Where to land after signing up, carried over from the sign-in page's
  // "Sign up" link. User-controlled — validated down to an in-app path.
  const { callbackUrl } = await searchParams;
  const callbackPath = safeCallbackPath(callbackUrl);
  // DISABLE_SIGNUP instances don't offer self-registration; BetterAuth also
  // rejects a direct POST to /api/auth/sign-up/email (this is just the UI).
  // Registering is email/password only, so DISABLE_PASSWORD_LOGIN removes it
  // too — those instances provision users through the IdP on first login.
  if (signupDisabled || passwordLoginDisabled) redirect(signInPath(callbackPath));
  return <SignUpForm callbackPath={callbackPath} />;
}
