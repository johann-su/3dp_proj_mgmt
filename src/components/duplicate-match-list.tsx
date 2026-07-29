import Link from "next/link";
import Image from "next/image";
import { Box, ExternalLink } from "lucide-react";
import type { DuplicateMatch } from "@/lib/duplicates";
import { formatDate } from "@/lib/format";

// The existing models a duplicate prompt is flagging, shared by the URL-import
// dialog and the create/edit form's upload dialog (issue #118). Each row links
// out in a new tab on purpose: the user is mid-import with staged files and a
// half-filled form, so navigating away in place would lose it.
export function DuplicateMatchList({ matches }: { matches: DuplicateMatch[] }) {
  return (
    <ul className="grid max-h-64 gap-2 overflow-y-auto">
      {matches.map((match) => (
        <li key={match.id}>
          <Link
            href={`/models/${match.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-md border p-2 transition-colors hover:bg-accent"
          >
            <div className="relative size-12 shrink-0 overflow-hidden rounded bg-muted">
              {match.coverSrc ? (
                <Image
                  src={match.coverSrc}
                  alt=""
                  fill
                  sizes="48px"
                  className="object-cover"
                />
              ) : (
                <Box className="absolute inset-0 m-auto size-5 text-muted-foreground/50" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{match.title}</div>
              <div className="truncate text-xs text-muted-foreground">
                added by {match.ownerName} on{" "}
                {formatDate(new Date(match.createdAt))}
              </div>
            </div>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
