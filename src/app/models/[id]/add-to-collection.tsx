"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, FolderPlus } from "lucide-react";
import { toggleModelInCollection } from "@/app/collections/actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type CollectionOption = {
  id: string;
  title: string;
  inCollection: boolean;
};

export function AddToCollection({
  modelId,
  collections,
}: {
  modelId: string;
  collections: CollectionOption[];
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>(
    Object.fromEntries(collections.map((c) => [c.id, c.inCollection])),
  );

  async function toggle(collectionId: string, next: boolean) {
    setChecked((prev) => ({ ...prev, [collectionId]: next }));
    const result = await toggleModelInCollection({
      collectionId,
      modelId,
      inCollection: next,
    });
    if (result.error) {
      setChecked((prev) => ({ ...prev, [collectionId]: !next }));
      toast.error(result.error);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-full">
          <FolderPlus className="size-4" />
          Add to collection
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {collections.length === 0 ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            You have no collections yet.
          </DropdownMenuLabel>
        ) : (
          collections.map((collection) => {
            const isChecked = checked[collection.id] ?? false;
            return (
              <DropdownMenuItem
                key={collection.id}
                // keep the menu open so several collections can be toggled
                onSelect={(e) => {
                  e.preventDefault();
                  toggle(collection.id, !isChecked);
                }}
                className="justify-between gap-2"
              >
                <span className="truncate">{collection.title}</span>
                <span
                  aria-hidden
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                    isChecked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input",
                  )}
                >
                  {isChecked && <Check className="size-3" strokeWidth={3} />}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/collections/new">
            <FolderPlus className="size-4" />
            New collection
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
