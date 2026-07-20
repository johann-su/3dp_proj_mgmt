"use client";

import {
  Fragment,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  FolderPlus,
  GripVertical,
  Image as ImageIcon,
  Link2,
  Minus,
  Plus,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { parseBomCsv, MAX_BOM_ITEMS, type BomItemInput } from "@/lib/bom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const EMPTY_ITEM: BomItemInput = {
  name: "",
  quantity: "",
  link: null,
  imageUrl: null,
  section: null,
};

// Steps the leading number of a free-form quantity ("4" -> "5", "1x" -> "2x",
// "0.5 kg" -> "1.5 kg") and leaves the unit suffix alone. Values without a
// leading number start counting at 1; steps never go below 1's territory.
function stepQuantity(value: string, delta: 1 | -1): string {
  const match = value.trim().match(/^(\d+(?:[.,]\d+)?)(.*)$/);
  if (!match) return "1" + (value.trim() ? ` ${value.trim()}` : "");
  const num = parseFloat(match[1].replace(",", "."));
  const next = num + delta;
  if (next < 1) return value.trim();
  const rounded = Math.round(next * 100) / 100;
  return String(rounded) + match[2];
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-wide leading-none text-muted-foreground">
      {children}
    </span>
  );
}

// Live preview of the item's image URL — the same thumbnail the model page
// renders, so a working URL is visible while editing. Keyed by URL from the
// caller so the error state resets when the URL changes.
function Thumb({ url }: { url: string | null }) {
  const [broken, setBroken] = useState(false);
  const valid =
    !!url &&
    (() => {
      try {
        const u = new URL(url);
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    })();
  if (valid && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        onError={() => setBroken(true)}
        className="size-14 shrink-0 self-center rounded-md border object-cover bg-muted"
      />
    );
  }
  return (
    <div className="size-14 shrink-0 self-center rounded-md border border-dashed bg-muted/50 flex items-center justify-center">
      <Wrench className="size-4 text-muted-foreground/40" />
    </div>
  );
}

// One rendered block of items: the ungrouped block (section null) or a named
// section. `index` is the item's position in the flat `items` prop.
type Group = { section: string | null; items: { item: BomItemInput; index: number }[] };

// Insertion slot a dragged card would land in: before the `index`-th card of
// `section` (index === group length means "at the end").
type DropTarget = { section: string | null; index: number };

export function BomEditor({
  items,
  setItems,
}: {
  items: BomItemInput[];
  setItems: (items: BomItemInput[]) => void;
}) {
  const csvInputRef = useRef<HTMLInputElement>(null);
  // Section names created or edited here. Sections found on items (loaded
  // from the server) are merged in below, so this only has to track sections
  // the server can't know about — freshly added or currently empty ones.
  const [ownSections, setOwnSections] = useState<string[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // A card is only draggable while its grip is pressed, so text in the
  // inputs stays selectable.
  const [armedIndex, setArmedIndex] = useState<number | null>(null);

  const sectionNames = useMemo(() => {
    const names: string[] = [];
    for (const name of [...ownSections, ...items.map((i) => i.section)]) {
      if (name !== null && !names.includes(name)) names.push(name);
    }
    return names;
  }, [ownSections, items]);

  const groups: Group[] = useMemo(() => {
    const bySection = new Map<string | null, Group>([
      [null, { section: null, items: [] }],
      ...sectionNames.map(
        (name): [string, Group] => [name, { section: name, items: [] }],
      ),
    ]);
    items.forEach((item, index) => {
      (bySection.get(item.section) ?? bySection.get(null))!.items.push({
        item,
        index,
      });
    });
    return [...bySection.values()];
  }, [items, sectionNames]);

  function flatten(next: Group[]): BomItemInput[] {
    return next.flatMap((g) => g.items.map(({ item }) => item));
  }

  // Stable-sorts the flat list into render order (ungrouped, then sections),
  // used when an operation moves items across groups in place.
  function sortBySections(list: BomItemInput[], names: string[]) {
    const rank = (s: string | null) => (s === null ? 0 : names.indexOf(s) + 1);
    return [...list].sort((a, b) => rank(a.section) - rank(b.section));
  }

  function update(index: number, patch: Partial<BomItemInput>) {
    setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function addItem(section: string | null) {
    setItems(
      flatten(
        groups.map((g) =>
          g.section === section
            ? { ...g, items: [...g.items, { item: { ...EMPTY_ITEM, section }, index: -1 }] }
            : g,
        ),
      ),
    );
  }

  function addSection() {
    let name = "New section";
    for (let i = 2; sectionNames.includes(name); i++) name = `New section ${i}`;
    setOwnSections([...sectionNames, name]);
  }

  function renameSection(oldName: string, newName: string) {
    const names = sectionNames.map((n) => (n === oldName ? newName : n));
    setOwnSections(names);
    setItems(
      sortBySections(
        items.map((it) => (it.section === oldName ? { ...it, section: newName } : it)),
        names,
      ),
    );
  }

  // Swaps a section with its neighbour. Buttons instead of drag and drop —
  // sections are too tall to drag comfortably.
  function moveSection(index: number, dir: -1 | 1) {
    const swap = index + dir;
    if (swap < 0 || swap >= sectionNames.length) return;
    const names = [...sectionNames];
    [names[index], names[swap]] = [names[swap], names[index]];
    setOwnSections(names);
    setItems(sortBySections(items, names));
  }

  function deleteSection(name: string) {
    const names = sectionNames.filter((n) => n !== name);
    setOwnSections(names);
    setItems(
      sortBySections(
        items.map((it) => (it.section === name ? { ...it, section: null } : it)),
        names,
      ),
    );
  }

  function updateDropTarget(t: DropTarget) {
    setDropTarget((prev) =>
      prev && prev.section === t.section && prev.index === t.index ? prev : t,
    );
  }

  function completeDrop() {
    if (dragIndex === null || dropTarget === null) return;
    const dragged = items[dragIndex];
    const next = groups.map((g) => ({ ...g, items: [...g.items] }));
    const target = next.find((g) => g.section === dropTarget.section);
    if (!dragged || !target) return;
    let insertAt = dropTarget.index;
    for (const g of next) {
      const pos = g.items.findIndex(({ index }) => index === dragIndex);
      if (pos === -1) continue;
      // Slots were computed with the dragged card still in place; removing
      // it shifts later slots in the same group down by one.
      if (g === target && pos < insertAt) insertAt--;
      g.items.splice(pos, 1);
    }
    target.items.splice(insertAt, 0, {
      item: { ...dragged, section: dropTarget.section },
      index: -1,
    });
    setItems(flatten(next));
  }

  function clearDrag() {
    setDragIndex(null);
    setDropTarget(null);
    setArmedIndex(null);
  }

  async function handleCsv(file: File) {
    const result = parseBomCsv(await file.text());
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    const merged = [...items.filter((i) => i.name.trim()), ...result.items];
    if (merged.length > MAX_BOM_ITEMS) {
      toast.error(`A BOM can have at most ${MAX_BOM_ITEMS} items`);
      return;
    }
    setItems(sortBySections(merged, sectionNames));
    toast.success(
      `Imported ${result.items.length} BOM item${result.items.length === 1 ? "" : "s"} from ${file.name}`,
    );
  }

  function renderCard({ item, index }: Group["items"][number]) {
    return (
      <div
        draggable={armedIndex === index}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", item.name);
          setDragIndex(index);
        }}
        onDragEnd={clearDrag}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          completeDrop();
          clearDrag();
        }}
        className={cn(
          "flex items-start gap-2.5 rounded-md border bg-background p-2.5",
          dragIndex === index && "opacity-40",
        )}
      >
        <button
          type="button"
          aria-label={`Drag to reorder ${item.name || "item"}`}
          onPointerDown={() => setArmedIndex(index)}
          onPointerUp={() => setArmedIndex(null)}
          className="shrink-0 self-center cursor-grab touch-none rounded text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </button>
        <Thumb key={item.imageUrl ?? ""} url={item.imageUrl} />
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="grid gap-2 grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid content-start gap-1">
              <FieldLabel>Item</FieldLabel>
              <Input
                aria-label="Item name"
                placeholder="M3 heat set insert"
                value={item.name}
                onChange={(e) => update(index, { name: e.target.value })}
              />
            </div>
            <div className="grid content-start gap-1">
              <FieldLabel>Qty</FieldLabel>
              <div className="flex h-9 items-center rounded-md border bg-transparent shadow-xs">
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Decrease quantity"
                  className="flex h-full w-7 items-center justify-center rounded-l-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() =>
                    update(index, { quantity: stepQuantity(item.quantity, -1) })
                  }
                >
                  <Minus className="size-3" />
                </button>
                <input
                  aria-label="Quantity"
                  placeholder="1"
                  value={item.quantity}
                  onChange={(e) => update(index, { quantity: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                      e.preventDefault();
                      update(index, {
                        quantity: stepQuantity(
                          item.quantity,
                          e.key === "ArrowUp" ? 1 : -1,
                        ),
                      });
                    }
                  }}
                  className="h-full w-14 min-w-0 border-x bg-transparent text-center text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Increase quantity"
                  className="flex h-full w-7 items-center justify-center rounded-r-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() =>
                    update(index, { quantity: stepQuantity(item.quantity, 1) })
                  }
                >
                  <Plus className="size-3" />
                </button>
              </div>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid content-start gap-1">
              <FieldLabel>Link</FieldLabel>
              <div className="relative">
                <Link2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  aria-label="Link"
                  placeholder="https://… (optional)"
                  value={item.link ?? ""}
                  onChange={(e) => update(index, { link: e.target.value || null })}
                  className="pl-8"
                />
              </div>
            </div>
            <div className="grid content-start gap-1">
              <FieldLabel>Image URL</FieldLabel>
              <div className="relative">
                <ImageIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  aria-label="Image URL"
                  placeholder="https://… (optional)"
                  value={item.imageUrl ?? ""}
                  onChange={(e) => update(index, { imageUrl: e.target.value || null })}
                  className="pl-8"
                />
              </div>
            </div>
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 self-start -mt-0.5 -mr-0.5"
              aria-label={`Remove BOM item ${item.name || index + 1}`}
              onClick={() => setItems(items.filter((_, j) => j !== index))}
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove item</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  function renderGroupItems(group: Group) {
    const showSlot = (slot: number) =>
      dragIndex !== null &&
      dropTarget?.section === group.section &&
      dropTarget.index === slot;
    return (
      <>
        {group.items.map((entry, pos) => (
          <Fragment key={entry.index}>
            {showSlot(pos) && <div className="h-0.5 rounded-full bg-primary" />}
            <div
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                const before = e.clientY < rect.top + rect.height / 2;
                updateDropTarget({ section: group.section, index: pos + (before ? 0 : 1) });
              }}
            >
              {renderCard(entry)}
            </div>
          </Fragment>
        ))}
        {showSlot(group.items.length) && (
          <div className="h-0.5 rounded-full bg-primary" />
        )}
      </>
    );
  }

  // dragover/drop on a group container targets the end of that group;
  // handlers on the cards themselves stopPropagation to take precedence.
  function groupDropProps(group: Group) {
    return {
      onDragOver: (e: DragEvent) => {
        if (dragIndex === null) return;
        e.preventDefault();
        updateDropTarget({ section: group.section, index: group.items.length });
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        completeDrop();
        clearDrag();
      },
    };
  }

  const [ungrouped, ...sectionGroups] = groups;

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label>Bill of materials (optional)</Label>
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleCsv(file);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => csvInputRef.current?.click()}
        >
          <FileSpreadsheet className="size-4" />
          Upload CSV
        </Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-1">
        Filament, heat set inserts, screws… CSV columns: name, quantity, link,
        image. Drag the grip to reorder items or move them between sections.
      </p>

      {(ungrouped.items.length > 0 || dragIndex !== null) && (
        <div className="grid gap-2" {...groupDropProps(ungrouped)}>
          {renderGroupItems(ungrouped)}
          {ungrouped.items.length === 0 && sectionGroups.length > 0 && (
            <div
              className={cn(
                "rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground",
                dropTarget?.section === null && "border-primary text-foreground",
              )}
            >
              Drop here to remove from its section
            </div>
          )}
        </div>
      )}

      {/* Keyed by position, not name: keying by name would remount the block
          (and blur the name input) on every keystroke while renaming. */}
      {sectionGroups.map((group, i) => (
        <div
          key={i}
          className="rounded-lg border bg-muted/30"
          {...groupDropProps(group)}
        >
          <div className="flex items-center gap-2 border-b px-2 py-1.5">
            <Input
              aria-label="Section name"
              placeholder="Section name"
              value={group.section ?? ""}
              onChange={(e) => renameSection(group.section!, e.target.value)}
              className="h-7 border-none bg-transparent px-1 font-medium shadow-none focus-visible:ring-1 dark:bg-transparent"
            />
            <span className="shrink-0 text-xs text-muted-foreground">
              {group.items.length} item{group.items.length === 1 ? "" : "s"}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={`Move section ${group.section} up`}
                  disabled={i === 0}
                  onClick={() => moveSection(i, -1)}
                >
                  <ChevronUp className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Move section up</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={`Move section ${group.section} down`}
                  disabled={i === sectionGroups.length - 1}
                  onClick={() => moveSection(i, 1)}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Move section down</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label={`Delete section ${group.section}`}
                  onClick={() => deleteSection(group.section!)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete section (items move out of it)</TooltipContent>
            </Tooltip>
          </div>
          <div className="grid gap-2 p-2">
            {renderGroupItems(group)}
            {group.items.length === 0 && dragIndex === null && (
              <p className="px-1 py-1.5 text-center text-xs text-muted-foreground">
                No items yet — drag items here or add one below.
              </p>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-start text-muted-foreground"
              onClick={() => addItem(group.section)}
            >
              <Plus className="size-4" />
              Add item
            </Button>
          </div>
        </div>
      ))}

      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => addItem(null)}>
          <Plus className="size-4" />
          Add item
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={addSection}>
          <FolderPlus className="size-4" />
          Add section
        </Button>
      </div>
    </div>
  );
}
