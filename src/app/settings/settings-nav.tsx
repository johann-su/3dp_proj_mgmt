"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Cloud, Shapes, UserCog } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/settings", label: "Account", icon: UserCog },
  { href: "/settings/onshape", label: "Onshape", icon: Shapes },
  { href: "/settings/bambu", label: "Bambu Cloud", icon: Cloud },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto sm:flex-col sm:gap-0.5">
      {items.map((item) => {
        const active = pathname === item.href;
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
          </Link>
        );
      })}
    </nav>
  );
}
