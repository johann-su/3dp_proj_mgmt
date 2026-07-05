"use client";

// Slicer deep links (orcaslicer:// / bambustudio://) need an absolute URL to
// the .3mf file, which is only known in the browser — hence a client component.

import { ChevronDown, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SLICERS = [
  { name: "Orca Slicer", scheme: "orcaslicer" },
  { name: "Bambu Studio", scheme: "bambustudio" },
] as const;

export function OpenInSlicer({
  fileId,
  makerworldUrl,
}: {
  fileId: string;
  makerworldUrl?: string;
}) {
  function openInSlicer(scheme: string) {
    const fileUrl = `${window.location.origin}/api/files/${fileId}`;
    window.location.assign(`${scheme}://open/?file=${encodeURIComponent(fileUrl)}`);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="shrink-0">
          Open in
          <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SLICERS.map((slicer) => (
          <DropdownMenuItem
            key={slicer.scheme}
            onSelect={() => openInSlicer(slicer.scheme)}
          >
            {slicer.name}
          </DropdownMenuItem>
        ))}
        {makerworldUrl && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={makerworldUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" />
                MakerWorld
              </a>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
