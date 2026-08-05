import Link from "next/link";
import { Box } from "lucide-react";
import { CoverImage } from "@/components/cover-image";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { platformFromSourceUrl, platformLabels } from "@/lib/platform";

export type ModelCardData = {
  id: string;
  title: string;
  sourceUrl: string | null;
  user: { name: string };
  category: { name: string } | null;
  // `src` is the token-signed file URL (see fileSrc in @/lib/file-token),
  // signed server-side because this card also renders inside client
  // components (FeedGrid's infinite scroll). The first entry is the cover and
  // may be a video, which plays on hover (see CoverImage).
  files: { id: string; src: string; animated?: boolean; kind?: string }[];
  modelTags: { tag: { id: string; name: string } }[];
  // True when the model ships a `.scad` source, i.e. it's customizable via the
  // OpenSCAD parametric flow. Surfaced as a badge so browse cards flag it.
  parametric?: boolean;
};

export function ModelCard({ model }: { model: ModelCardData }) {
  const cover = model.files[0];
  const platform = platformFromSourceUrl(model.sourceUrl);
  return (
    <Link href={`/models/${model.id}`} className="group">
      <Card className="overflow-hidden h-full py-0 gap-0 border-0 shadow-sm transition-shadow group-hover:shadow-lg">
        <div className="relative aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
          {cover ? (
            <CoverImage
              src={cover.src}
              alt={model.title}
              animated={cover.animated}
              video={cover.kind === "video"}
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
              className="object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <Box className="size-10 text-muted-foreground/50" />
          )}
          {platform && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="absolute left-2 top-2 flex size-8 items-center justify-center rounded-lg bg-white/90 p-1.5 shadow-sm ring-1 ring-black/5 backdrop-blur">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/logos/${platform}.svg`}
                    alt={`${platformLabels[platform]} logo`}
                    className="size-full object-contain"
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">
                {platformLabels[platform]}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <CardContent className="p-3">
          <div className="font-medium truncate">{model.title}</div>
          <div className="text-sm text-muted-foreground truncate">
            by {model.user.name}
            {model.category ? ` · ${model.category.name}` : ""}
          </div>
          {(model.parametric || model.modelTags.length > 0) && (
            <div className="flex flex-wrap items-center gap-1 mt-2">
              {model.parametric && (
                <Badge
                  className="gap-1 bg-primary text-primary-foreground"
                  title="Customizable OpenSCAD model"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/customize.svg" alt="" className="size-3.5" />
                  Parametric
                </Badge>
              )}
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
