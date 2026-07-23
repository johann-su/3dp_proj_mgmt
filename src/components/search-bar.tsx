"use client";

import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Global ⌘K / Ctrl+K shortcut focuses the homepage search box, with a hint
// badge mirroring the shortcut mark in its idle state (hidden once focused
// so it doesn't collide with typed text). The ⌘ glyph is shown regardless of
// platform (both Cmd and Ctrl trigger it) — that's the convention users
// recognize, and avoids a client-only OS check that would mismatch SSR output.
export function SearchBar() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <form action="/search" className="flex w-full max-w-md gap-2">
      <div className="relative flex-1">
        <Input
          ref={inputRef}
          type="search"
          name="q"
          placeholder="Search models and collections…"
          className="pr-12"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {!focused && (
          <KbdGroup className="absolute right-2 top-1/2 -translate-y-1/2">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        )}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="submit" variant="secondary" aria-label="Search">
            <Search className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Search</TooltipContent>
      </Tooltip>
    </form>
  );
}
