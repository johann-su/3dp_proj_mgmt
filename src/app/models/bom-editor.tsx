"use client";

import { useRef } from "react";
import { toast } from "sonner";
import { FileSpreadsheet, Plus, X } from "lucide-react";
import { parseBomCsv, MAX_BOM_ITEMS, type BomItemInput } from "@/lib/bom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const EMPTY_ITEM: BomItemInput = { name: "", quantity: "", link: null, imageUrl: null };

export function BomEditor({
  items,
  setItems,
}: {
  items: BomItemInput[];
  setItems: (items: BomItemInput[]) => void;
}) {
  const csvInputRef = useRef<HTMLInputElement>(null);

  function update(index: number, patch: Partial<BomItemInput>) {
    setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
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
    setItems(merged);
    toast.success(
      `Imported ${result.items.length} BOM item${result.items.length === 1 ? "" : "s"} from ${file.name}`,
    );
  }

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
        Filament, heat set inserts, screws… CSV columns: name, quantity, link, image.
      </p>

      {items.length > 0 && (
        <div className="grid gap-2">
          <div className="hidden sm:grid grid-cols-[1fr_90px_1fr_1fr_28px] gap-2 text-xs text-muted-foreground px-1">
            <span>Item</span>
            <span>Qty</span>
            <span>Link (optional)</span>
            <span>Image URL (optional)</span>
            <span />
          </div>
          {items.map((item, i) => (
            <div
              key={i}
              className="grid grid-cols-2 sm:grid-cols-[1fr_90px_1fr_1fr_28px] gap-2 items-center"
            >
              <Input
                aria-label="Item name"
                placeholder="M3 heat set insert"
                value={item.name}
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <Input
                aria-label="Quantity"
                placeholder="4"
                value={item.quantity}
                onChange={(e) => update(i, { quantity: e.target.value })}
              />
              <Input
                aria-label="Link"
                placeholder="https://…"
                value={item.link ?? ""}
                onChange={(e) => update(i, { link: e.target.value || null })}
              />
              <Input
                aria-label="Image URL"
                placeholder="https://…"
                value={item.imageUrl ?? ""}
                onChange={(e) => update(i, { imageUrl: e.target.value || null })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Remove BOM item ${item.name || i + 1}`}
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start"
        onClick={() => setItems([...items, { ...EMPTY_ITEM }])}
      >
        <Plus className="size-4" />
        Add item
      </Button>
    </div>
  );
}
