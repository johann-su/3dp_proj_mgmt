import { oidcEnabled, oidcProviderName, signupDisabled } from "@/lib/auth";
import { safeCallbackPath } from "@/lib/callback-url";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  // Where to land after login (set by the proxy when a signed-out visitor
  // opens a shared link). User-controlled — validated down to an in-app path.
  const { callbackUrl } = await searchParams;
  const callbackPath = safeCallbackPath(callbackUrl);
  return (
    <SignInForm
      oidcProvider={oidcEnabled ? oidcProviderName : null}
      signupEnabled={!signupDisabled}
      callbackPath={callbackPath}
    />
  );
}
