import Link from "next/link";
import { Box } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export type ModelCardData = {
  id: string;
  title: string;
  user: { name: string };
  category: { name: string } | null;
  files: { id: string }[];
  modelTags: { tag: { id: string; name: string } }[];
};

export function ModelCard({ model }: { model: ModelCardData }) {
  const cover = model.files[0];
  return (
    <Link href={`/models/${model.id}`} className="group">
      <Card className="overflow-hidden h-full py-0 gap-0 border-0 shadow-sm transition-shadow group-hover:shadow-lg">
        <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/files/${cover.id}`}
              alt={model.title}
              className="w-full h-full object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <Box className="size-10 text-muted-foreground/50" />
          )}
        </div>
        <CardContent className="p-3">
          <div className="font-medium truncate">{model.title}</div>
          <div className="text-sm text-muted-foreground truncate">
            by {model.user.name}
            {model.category ? ` · ${model.category.name}` : ""}
          </div>
          {model.modelTags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {model.modelTags.slice(0, 3).map(({ tag }) => (
                <Badge key={tag.id} variant="secondary" className="text-xs">
                  {tag.name}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
