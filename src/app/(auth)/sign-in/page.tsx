import { oidcEnabled, oidcProviderName, signupDisabled } from "@/lib/auth";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <SignInForm
      oidcProvider={oidcEnabled ? oidcProviderName : null}
      signupEnabled={!signupDisabled}
    />
  );
}
