"use client";

import { Download, ExternalLink, Eye, FileBox, Wrench } from "lucide-react";
import type { BomItemInput } from "@/lib/bom";
import { formatBytes, formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImageGallery } from "@/components/image-gallery";

export type ModelPreviewData = {
  title: string;
  description: string;
  categoryName: string | null;
  tags: string[];
  bom: BomItemInput[];
  images: { src: string }[];
  printFiles: { filename: string; size: number }[];
  userName: string;
  createdAt: Date;
};

function linkHostname(link: string) {
  try {
    return new URL(link).hostname;
  } catch {
    return link;
  }
}

// Mirrors the layout of the model detail page (src/app/models/[id]/page.tsx)
// so the wizard can show how a model will look before it is saved.
export function ModelPreview({ data }: { data: ModelPreviewData }) {
  const bomItems = data.bom.filter((item) => item.name.trim());

  return (
    <div className="rounded-lg border border-dashed">
      <div className="flex items-center gap-2 border-b border-dashed px-4 py-2 text-xs text-muted-foreground">
        <Eye className="size-3.5" />
        Preview — this is how the model page will look
      </div>
      <div className="p-4 sm:p-6">
        <div className="grid gap-8 lg:grid-cols-[1fr_400px]">
          <div>
            <ImageGallery images={data.images} title={data.title} />

            {bomItems.length > 0 && (
              <Card className="mt-8">
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-base">
                    Bill of materials ({bomItems.length})
                  </CardTitle>
                  <Button size="sm" variant="outline" disabled>
                    <Download className="size-4" />
                    Download CSV
                  </Button>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {bomItems.map((item, i) => (
                    <div
                      key={i}
                      className="flex min-w-0 items-center gap-3 border rounded-md px-3 py-2"
                    >
                      {item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.imageUrl}
                          alt={item.name}
                          className="size-10 rounded object-cover bg-muted shrink-0"
                        />
                      ) : (
                        <div className="size-10 rounded bg-muted flex items-center justify-center shrink-0">
                          <Wrench className="size-4 text-muted-foreground/60" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {item.name}
                        </div>
                        {item.link && (
                          <span className="text-xs text-primary inline-flex items-center gap-1">
                            <ExternalLink className="size-3" />
                            {linkHostname(item.link)}
                          </span>
                        )}
                      </div>
                      <span className="ml-auto shrink-0 text-sm text-muted-foreground">
                        ×&nbsp;{item.quantity.trim() || "1"}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <div className="mt-8">
              <h2 className="text-lg font-semibold mb-2">Description</h2>
              {data.description ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {data.description}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">No description.</p>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {data.title.trim() || "Untitled model"}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                by {data.userName} · {formatDate(data.createdAt)}
              </p>
            </div>

            {(data.categoryName || data.tags.length > 0) && (
              <div className="flex flex-wrap gap-1.5">
                {data.categoryName && <Badge>{data.categoryName}</Badge>}
                {data.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Files ({data.printFiles.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                {data.printFiles.map((file, i) => (
                  <div
                    key={`${file.filename}-${i}`}
                    className="flex min-w-0 items-center gap-3 border rounded-md px-3 py-2"
                  >
                    <FileBox className="size-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {file.filename}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatBytes(file.size)}
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="ml-auto shrink-0"
                      aria-label={`Download ${file.filename}`}
                      disabled
                    >
                      <Download className="size-4" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
