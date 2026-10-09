"use client";

import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { bomToCsv } from "@/lib/bom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { BomList } from "./bom-list";

type BomItem = React.ComponentProps<typeof BomList>["items"][number];

export function BomSection({
  items,
  downloadUrl,
  csvFilename,
  interactive = true,
}: {
  items: BomItem[];
  // Server CSV route (member model page; session-gated).
  downloadUrl?: string;
  // Without a route, build the CSV in the browser from `items` and save it
  // under this name — the public share view, which has no session for the
  // route and needs no new public endpoint for data it already shows.
  csvFilename?: string;
  interactive?: boolean;
}) {
  const [open, setOpen] = useState(false);

  function downloadInline() {
    const blob = new Blob([bomToCsv(items)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFilename!;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card className="mt-8">
        <CardHeader className="flex flex-row items-center justify-between">
          <CollapsibleTrigger className="group -m-2 flex flex-1 items-center gap-2 rounded-md p-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
            <span className="text-base font-semibold">
              Bill of materials ({items.length})
            </span>
          </CollapsibleTrigger>
          {downloadUrl ? (
            <Button asChild size="sm" variant="outline">
              <a href={downloadUrl}>
                <Download className="size-4" />
                Download CSV
              </a>
            </Button>
          ) : csvFilename ? (
            <Button size="sm" variant="outline" onClick={downloadInline}>
              <Download className="size-4" />
              Download CSV
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled>
              <Download className="size-4" />
              Download CSV
            </Button>
          )}
        </CardHeader>
        <CollapsibleContent>
          <CardContent>
            <BomList items={items} interactive={interactive} />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
