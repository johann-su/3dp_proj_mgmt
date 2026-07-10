import Link from "next/link";
import Image from "next/image";
import { FolderOpen } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export type MyCollectionData = {
  id: string;
  title: string;
  collectionModels: {
    model: { files: { id: string }[] };
  }[];
};

// Single-cover collection card used on the "My Collections" page (distinct
// from the stacked CollectionCard used in the homepage preview).
export function MyCollectionCard({ collection }: { collection: MyCollectionData }) {
  const cover = collection.collectionModels
    .map((cm) => cm.model.files[0])
    .find(Boolean);
  const count = collection.collectionModels.length;

  return (
    <Link href={`/collections/${collection.id}`} className="group">
      <Card className="overflow-hidden h-full py-0 gap-0 border-0 shadow-sm transition-shadow group-hover:shadow-lg">
        <div className="relative aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
          {cover ? (
            <Image
              src={`/api/files/${cover.id}`}
              alt={collection.title}
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
              className="object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <FolderOpen className="size-10 text-muted-foreground/50" />
          )}
        </div>
        <CardContent className="p-3">
          <div className="font-medium truncate">{collection.title}</div>
          <div className="text-sm text-muted-foreground">
            {count} model{count === 1 ? "" : "s"}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
