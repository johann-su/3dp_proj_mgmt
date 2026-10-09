"use client";

import { usePathname } from "next/navigation";
import { Box } from "lucide-react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ImportProgressIndicator } from "@/components/import-progress";
import { ThemeToggle } from "@/components/theme-toggle";

type SessionUser = { name: string; email: string };

// Page chrome. Members get the sidebar app; an anonymous visitor on a public
// share link (/share/…) gets a bare header instead — every sidebar entry
// would only bounce them to sign-in, and the share page carries its own
// sign-in prompt (share-banner.tsx). Signed-in members keep the full chrome
// on share pages too.
export function AppShell({
  user,
  children,
}: {
  user: SessionUser | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  if (!user && (pathname === "/share" || pathname.startsWith("/share/"))) {
    return (
      <div className="flex min-h-svh flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Box className="size-5" />
          </div>
          <span className="font-semibold">Print Vault</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      <SidebarInset>
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <SidebarTrigger />
          {user && (
            <div className="ml-auto">
              <ImportProgressIndicator />
            </div>
          )}
        </header>
        <main className="flex-1">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
