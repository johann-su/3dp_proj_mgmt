"use client";

// Slicer deep links (orcaslicer:// / bambustudioopen://) need an absolute URL
// to the .3mf file, which is only known in the browser — hence a client
// component.

import { Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Orca and Bambu register different URL schemes (`orcaslicer:` vs.
// `bambustudioopen:` — NOT `bambustudio:`, an unregistered scheme fails
// silently) AND parse the link differently, so each builds its own URL from
// the same tokened file URL (`.../api/files/<id>/<token>/<name>.3mf`) and the
// `.3mf` name. Both apps download the URL themselves, without the session
// cookie, so the URL carries a signed access token — as a PATH segment, not
// `?token=`, because Orca keeps the query string when naming the file (below):
//
// - Orca matches `orcaslicer://open?file=<url>`, treats the entire remainder
//   as the URL to fetch, and names the saved file from that URL's LAST PATH
//   SEGMENT without stripping any query string (`filename_from_url` in
//   Downloader.cpp) — the trailing `<name>.3mf` segment yields a real `.3mf`
//   name instead of the bare UUID (this matches the link Printables/MakerWorld
//   generate). A `&name=` param would just corrupt the fetched URL (our route
//   404s on the bad id), so it must not be used here. (`open?file=`, no slash:
//   Orca's regex accepts a `open/?` slash too, but that's the legacy
//   PrusaSlicer "mysterious slash".)
// - Bambu's macOS handler takes whatever follows `bambustudioopen://`, decodes
//   it once, and treats it as the raw download URL (rejected unless it starts
//   with http/https — an `open/?file=` prefix breaks it). It then splits a
//   trailing `&name=` off to name the file, refusing it unless the name ends in
//   `.3mf` (the bare-UUID URL has no extension). Matching MakerWorld's own
//   links, the whole `<url>&name=<file>.3mf` is percent-encoded as one blob so
//   the browser can't mangle the literal `&`/`:` before the OS gets it.
const SLICERS = [
  {
    name: "Orca Slicer",
    buildUrl: (fileUrl: string) =>
      `orcaslicer://open?file=${encodeURIComponent(fileUrl)}`,
  },
  {
    name: "Bambu Studio",
    buildUrl: (fileUrl: string, name: string) =>
      `bambustudioopen://${encodeURIComponent(`${fileUrl}&name=${name}`)}`,
  },
] as const;

export function FileDownloadMenu({
  fileId,
  token,
  filename,
  makerworldUrl,
}: {
  fileId: string;
  // Signed /api/files access token (minted server-side, see @/lib/file-token)
  // — it, not a cookie, is what authenticates the slicer's download.
  token: string;
  filename: string;
  makerworldUrl?: string;
}) {
  function openInSlicer(buildUrl: (fileUrl: string, name: string) => string) {
    const name = /\.3mf$/i.test(filename) ? filename : `${filename}.3mf`;
    const fileUrl = `${window.location.origin}/api/files/${fileId}/${token}/${encodeURIComponent(name)}`;
    window.location.assign(buildUrl(fileUrl, name));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="outline"
          className="shrink-0"
          aria-label={`Download or open ${filename}`}
        >
          <Download className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem asChild>
          <a href={`/api/files/${fileId}?download=1`}>
            <Download className="size-4" />
            Download
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Open in</DropdownMenuLabel>
        {SLICERS.map((slicer) => (
          <DropdownMenuItem
            key={slicer.name}
            onSelect={() => openInSlicer(slicer.buildUrl)}
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
