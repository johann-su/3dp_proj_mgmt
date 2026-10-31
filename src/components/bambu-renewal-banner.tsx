"use client";

// App-wide reminder that the user's Bambu Cloud login is about to expire (or
// already has), so MakerWorld downloads don't fail by surprise mid-import.
// The root layout only passes a reminder when one is due. Dismissing hides it
// for that exact state — an "expiring" dismissal comes back once it expires.

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDaysLeft } from "@/lib/bambu/token-expiry";

export type BambuReminder = {
  state: "expiring" | "expired";
  daysLeft: number | null;
  expiresAt: string | null;
};

const DISMISSED_KEY = "printvault-dismissed-bambu-reminder";
// Same-tab notification; the "storage" event only fires in other tabs.
const DISMISSED_EVENT = "printvault:bambu-reminder-dismissed";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(DISMISSED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(DISMISSED_EVENT, onChange);
  };
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null; // Storage blocked — just show the reminder.
  }
}

function reminderKey(reminder: BambuReminder): string {
  return `${reminder.state}:${reminder.expiresAt ?? ""}`;
}

export function BambuRenewalBanner({ reminder }: { reminder: BambuReminder }) {
  const pathname = usePathname();
  const key = reminderKey(reminder);
  // The server snapshot reads as dismissed, so the banner renders only after
  // hydration — whether it was dismissed lives in localStorage.
  const dismissedKey = useSyncExternalStore(subscribe, readDismissed, () => key);
  const dismissed = dismissedKey === key;

  // The settings page shows the same state with the renew form right there.
  if (dismissed || pathname === "/settings/bambu") return null;

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISSED_KEY, key);
    } catch {
      return; // Can't remember the dismissal, so keep showing it.
    }
    window.dispatchEvent(new Event(DISMISSED_EVENT));
  }

  const expired = reminder.state === "expired";

  return (
    <div
      role="status"
      className={
        "flex items-center gap-3 border-b px-4 py-2 text-sm " +
        (expired
          ? "bg-destructive/10 text-destructive"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400")
      }
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {expired
          ? "Your Bambu Cloud login has expired — MakerWorld imports can't download files until you renew it."
          : `Your Bambu Cloud login expires in ${formatDaysLeft(reminder.daysLeft ?? 0)}.`}
      </span>
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link href="/settings/bambu">Renew login</Link>
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            aria-label="Dismiss reminder"
            onClick={dismiss}
          >
            <X className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Dismiss reminder</TooltipContent>
      </Tooltip>
    </div>
  );
}
