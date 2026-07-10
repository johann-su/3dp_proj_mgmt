import { redirect } from "next/navigation";
import { signupDisabled } from "@/lib/auth";
import { SignUpForm } from "./sign-up-form";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  // DISABLE_SIGNUP instances don't offer self-registration; BetterAuth also
  // rejects a direct POST to /api/auth/sign-up/email (this is just the UI).
  if (signupDisabled) redirect("/sign-in");
  return <SignUpForm />;
}
