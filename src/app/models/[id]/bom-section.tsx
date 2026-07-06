"use client";

import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { BomList } from "../bom-list";

type BomItem = React.ComponentProps<typeof BomList>["items"][number];

export function BomSection({
  modelId,
  items,
}: {
  modelId: string;
  items: BomItem[];
}) {
  const [open, setOpen] = useState(true);

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
          <Button asChild size="sm" variant="outline">
            <a href={`/api/models/${modelId}/bom`}>
              <Download className="size-4" />
              Download CSV
            </a>
          </Button>
        </CardHeader>
        <CollapsibleContent>
          <CardContent>
            <BomList items={items} />
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
