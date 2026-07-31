"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Cloud, Copy, Shapes, Upload, UserCog, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/settings", label: "Account", icon: UserCog },
  { href: "/settings/onshape", label: "Onshape", icon: Shapes },
  { href: "/settings/bambu", label: "Bambu Cloud", icon: Cloud },
  { href: "/settings/slice-push", label: "Slicer push", icon: Upload },
];

// These hide unless the instance offers them; the pages enforce it
// server-side (404 / admin check) rather than trusting the nav.
const mcpItem = { href: "/settings/mcp", label: "AI access", icon: Bot };
const usersItem = { href: "/settings/users", label: "Users", icon: Users };
const duplicatesItem = {
  href: "/settings/duplicates",
  label: "Duplicates",
  icon: Copy,
};

export function SettingsNav({
  showMcp,
  showUsers,
  showDuplicates,
  duplicateCount,
}: {
  showMcp: boolean;
  showUsers: boolean;
  showDuplicates: boolean;
  // Open flags, shown as a count next to the entry so a moderator doesn't have
  // to open the page to find out there's nothing to do.
  duplicateCount: number;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto sm:flex-col sm:gap-0.5">
      {[
        ...items,
        ...(showMcp ? [mcpItem] : []),
        ...(showUsers ? [usersItem] : []),
        ...(showDuplicates ? [duplicatesItem] : []),
      ].map((item) => {
        const active = pathname === item.href;
        const badge = item === duplicatesItem && duplicateCount > 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
            {badge && (
              <span className="ml-auto rounded-full bg-muted px-1.5 text-xs font-normal tabular-nums">
                {duplicateCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
