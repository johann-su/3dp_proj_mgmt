import type { Metadata } from "next";
import { Open_Sans, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/components/app-shell";
import { getSession } from "@/lib/auth";
import { getBambuStatus } from "@/lib/bambu/credentials";
import type { BambuReminder } from "@/components/bambu-renewal-banner";
import { reportError } from "@/lib/telemetry";
import "./globals.css";

const openSans = Open_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Print Vault",
  description: "Self-hosted project management for 3D printing models",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getSession();
  const bambuReminder = session ? await loadBambuReminder(session.user.id) : null;

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${openSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>
            <AppShell user={session?.user ?? null} bambuReminder={bambuReminder}>
              {children}
            </AppShell>
          </TooltipProvider>
          <Toaster richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}

// The header's "renew your Bambu login" reminder, when one is due. A lookup
// failure must never take down every page, so it degrades to no reminder.
async function loadBambuReminder(userId: string): Promise<BambuReminder | null> {
  try {
    const status = await getBambuStatus(userId);
    if (status.state !== "expiring" && status.state !== "expired") return null;
    return {
      state: status.state,
      daysLeft: status.daysLeft ?? null,
      expiresAt: status.expiresAt ?? null,
    };
  } catch (err) {
    reportError("Bambu reminder lookup failed", err);
    return null;
  }
}
