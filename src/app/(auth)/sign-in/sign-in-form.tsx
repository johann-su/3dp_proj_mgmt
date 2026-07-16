"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { authClient, signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function SignInForm({
  oidcProvider,
  signupEnabled,
  callbackPath,
}: {
  oidcProvider: string | null;
  signupEnabled: boolean;
  // Server-validated in-app path to land on after login (null → homepage).
  callbackPath: string | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const destination = callbackPath ?? "/";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setLoading(true);
    const { error } = await signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setLoading(false);
    if (error) {
      toast.error(error.message ?? "Sign in failed");
      return;
    }
    router.push(destination);
    router.refresh();
  }

  async function handleSso() {
    setSsoLoading(true);
    const { error } = await authClient.signIn.oauth2({
      providerId: "oidc",
      callbackURL: destination,
    });
    // On success the browser is redirected to the identity provider.
    if (error) {
      setSsoLoading(false);
      toast.error(error.message ?? "SSO sign in failed");
    }
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Welcome back to Print Vault.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
            {signupEnabled && (
              <p className="text-sm text-muted-foreground text-center">
                No account?{" "}
                <Link
                  href={
                    callbackPath
                      ? `/sign-up?callbackUrl=${encodeURIComponent(callbackPath)}`
                      : "/sign-up"
                  }
                  className="underline"
                >
                  Sign up
                </Link>
              </p>
            )}
          </form>

          {oidcProvider && (
            <>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={ssoLoading}
                onClick={handleSso}
              >
                <KeyRound className="size-4" />
                {ssoLoading ? "Redirecting…" : `Continue with ${oidcProvider}`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
