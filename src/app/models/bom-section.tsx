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
  csvFilename,
  interactive = true,
}: {
  items: BomItem[];
  // Enables "Download CSV": the CSV is built in the browser from `items`
  // (bomToCsv) and saved under this name. Client-side for members and the
  // public share view alike — the page already holds the data, so there is
  // no route to keep access-checked. Unset in the create/version previews.
  csvFilename?: string;
  interactive?: boolean;
}) {
  const [open, setOpen] = useState(false);

  function downloadCsv() {
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
          {csvFilename ? (
            <Button size="sm" variant="outline" onClick={downloadCsv}>
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
