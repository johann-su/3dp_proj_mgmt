import Link from "next/link";
import { FolderOpen, Layers, Sparkles, User } from "lucide-react";
import { CoverImage } from "@/components/cover-image";

export type CollectionCardData = {
  id: string;
  title: string;
  user: { name: string };
  collectionModels: {
    model: {
      id: string;
      // Token-signed file URL, signed server-side (see ModelCardData.files).
      files: { id: string; src: string; animated?: boolean; kind?: string }[];
    };
  }[];
  // Smart collections (rule-based membership) hydrate only their first few
  // members as covers, so the real count comes separately.
  totalModels?: number;
  smart?: boolean;
};

export function CollectionCard({
  collection,
}: {
  collection: CollectionCardData;
}) {
  const covers = collection.collectionModels
    .map((cm) => cm.model.files[0])
    .filter(Boolean)
    .slice(0, 4);
  const totalModels = collection.totalModels ?? collection.collectionModels.length;
  const overflow = totalModels - 4;

  return (
    <Link href={`/collections/${collection.id}`} className="group block h-full">
      {/* Stacked card effect — each layer is offset by an even 4px step
          (inset + drop) so the peeking edges look evenly spaced. The wrapper
          is shrunk by the largest drop (8px) so the peeking layers stay
          within the grid cell instead of overflowing past its bottom edge,
          which otherwise made collection cards look taller than model cards. */}
      <div className="relative h-[calc(100%-8px)]">
        <div className="absolute inset-x-2 -bottom-2 h-full rounded-xl bg-muted/60 border border-border/40" />
        <div className="absolute inset-x-1 -bottom-1 h-full rounded-xl bg-muted/80 border border-border/50" />

        {/* Main card — fills the grid row height (like ModelCard's h-full Card)
            so models and collections line up at equal height. */}
        <div className="relative flex h-full flex-col rounded-xl overflow-hidden shadow-sm transition-shadow group-hover:shadow-lg border border-border/60 bg-card">
          {/* 2×2 image grid */}
          <div className="aspect-[4/3] grid grid-cols-2 grid-rows-2 bg-muted">
            {covers.length === 0 ? (
              <div className="col-span-2 row-span-2 flex items-center justify-center">
                <FolderOpen className="size-10 text-muted-foreground/40" />
              </div>
            ) : (
              <>
                {[0, 1, 2, 3].map((i) => {
                  const file = covers[i];
                  const isLast = i === 3 && overflow > 0;
                  return (
                    <div
                      key={i}
                      className="relative overflow-hidden bg-muted"
                      style={{
                        borderRight: i % 2 === 0 ? "1px solid hsl(var(--border) / 0.3)" : undefined,
                        borderBottom: i < 2 ? "1px solid hsl(var(--border) / 0.3)" : undefined,
                      }}
                    >
                      {file ? (
                        <CoverImage
                          src={file.src}
                          alt=""
                          animated={file.animated}
                          video={file.kind === "video"}
                          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 12vw"
                          className="object-cover transition-transform group-hover:scale-105"
                        />
                      ) : (
                        <div className="w-full h-full bg-muted" />
                      )}
                      {isLast && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                          <span className="text-white font-bold text-lg">
                            +{overflow}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* Info bar */}
          <div className="px-3 pt-2.5 pb-4">
            <div className="font-semibold truncate text-sm leading-snug">
              {collection.title}
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Layers className="size-3" />
                {totalModels} model{totalModels === 1 ? "" : "s"}
              </span>
              <span className="flex items-center gap-1">
                <User className="size-3" />
                {collection.user.name}
              </span>
              {collection.smart && (
                <span
                  className="flex items-center gap-1"
                  title="Membership is defined by rules and updates automatically"
                >
                  <Sparkles className="size-3" />
                  Smart
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
