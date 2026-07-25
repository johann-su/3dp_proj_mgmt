"use client";

// Downloads the model as a .zip (issue #94). The route builds the archive on
// the fly — reading every attached file out of S3 — so a big model takes a few
// seconds with nothing to show for it. Hence a fetch instead of a plain
// `<a download>`: the button can spin until the archive has actually arrived,
// and a failure becomes a toast instead of the route's JSON error rendered in
// a blank tab.

import { useState } from "react";
import { toast } from "sonner";
import { FileArchive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// `attachment; filename="Bracket_v5.zip"` — the server owns the name (model
// title + exported version), so a blob download has to read it back off the
// response rather than reinvent it.
function filenameFromResponse(res: Response): string {
  const disposition = res.headers.get("Content-Disposition") ?? "";
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? "model.zip";
}

export function ExportButton({ modelId }: { modelId: string }) {
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch(`/api/models/${modelId}/export`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Export failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFromResponse(res);
      // Firefox only follows the click when the anchor is in the document.
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoking synchronously can cancel the download before the browser has
      // read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={exporting}
          onClick={handleExport}
        >
          {exporting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FileArchive className="size-4" />
          )}
          {exporting ? "Exporting…" : "Export"}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Download files, images, description and BOM as a .zip
      </TooltipContent>
    </Tooltip>
  );
}
