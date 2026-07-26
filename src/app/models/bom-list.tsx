import { ExternalLink, Wrench } from "lucide-react";
import { bomImageProxySrc } from "@/lib/bom";

// Read-only BOM list shared by the model detail page and the wizard preview.
// Items are grouped under their section headings; ungrouped items come
// first, then sections in the order they first appear.

type BomListItem = {
  name: string;
  quantity: string;
  link: string | null;
  imageUrl: string | null;
  section: string | null;
};

function groupBySection<T extends { section: string | null }>(items: T[]) {
  const groups: { section: string | null; items: T[] }[] = [
    { section: null, items: [] },
  ];
  for (const item of items) {
    let group = groups.find((g) => g.section === item.section);
    if (!group) {
      group = { section: item.section, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}

function linkHostname(link: string) {
  try {
    return new URL(link).hostname;
  } catch {
    return link;
  }
}

// `interactive: false` renders links as plain text (used by the preview).
export function BomList({
  items,
  interactive = true,
}: {
  items: BomListItem[];
  interactive?: boolean;
}) {
  return (
    <div className="grid gap-2">
      {groupBySection(items).map((group, i) => (
        <div key={i} className="grid gap-2">
          {group.section && (
            <h3 className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground first:mt-0">
              {group.section}
            </h3>
          )}
          {group.items.map((item, j) => (
            <div
              key={j}
              className="flex min-w-0 items-center gap-3 border rounded-md px-3 py-2"
            >
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={bomImageProxySrc(item.imageUrl)}
                  alt={item.name}
                  className="size-10 rounded object-cover bg-muted shrink-0"
                />
              ) : (
                <div className="size-10 rounded bg-muted flex items-center justify-center shrink-0">
                  <Wrench className="size-4 text-muted-foreground/60" />
                </div>
              )}
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{item.name}</div>
                {item.link &&
                  (interactive ? (
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                    >
                      <ExternalLink className="size-3" />
                      {linkHostname(item.link)}
                    </a>
                  ) : (
                    <span className="text-xs text-primary inline-flex items-center gap-1">
                      <ExternalLink className="size-3" />
                      {linkHostname(item.link)}
                    </span>
                  ))}
              </div>
              <span className="ml-auto shrink-0 text-sm text-muted-foreground">
                ×&nbsp;{item.quantity.trim() || "1"}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
