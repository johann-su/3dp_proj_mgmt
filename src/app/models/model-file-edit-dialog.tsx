"use client";

// The per-row "edit file" dialog of the wizard's model file list: rename the
// file and — for stored .3mf files (issue #79) — override the printer it's
// meant for. The two parts persist
// differently on purpose: the name is form state applied with the model's
// "Save changes" (like the old inline rename), while a printer change is
// saved immediately through PATCH /api/models/[id]/printer-info, because it
// rewrites the stored archive and re-queues slicing. Untouched printer fields
// never call the endpoint, so a plain rename cannot trigger a re-slice.

import { useState } from "react";
import { toast } from "sonner";
import type { PrinterInfo } from "@/db/schema";
import { bedSizeForModel } from "@/lib/printer-beds";
import {
  BAMBU_NOZZLE_SIZES_MM,
  BAMBU_PRINTER_MODELS,
  DEFAULT_NOZZLE_MM,
} from "@/lib/printer-presets";
import { splitExtension } from "./model-form-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

const CUSTOM = "custom";

export function ModelFileEditDialog({
  filename,
  printer,
  onClose,
  onRename,
  onPrinterSaved,
}: {
  filename: string;
  // Present only when the printer may be edited (a stored .3mf). The
  // dialog opens reflecting the file's current profile, not blank.
  printer?: { modelId: string; fileId: string; current: PrinterInfo | null };
  onClose: () => void;
  onRename: (newName: string) => void;
  onPrinterSaved?: (info: PrinterInfo, size: number) => void;
}) {
  const [base, ext] = splitExtension(filename);
  const [name, setName] = useState(base);

  const current = printer?.current ?? null;
  const knownModel = BAMBU_PRINTER_MODELS.find((m) => m === current?.model);
  const [choice, setChoice] = useState<string>(
    knownModel ?? (current?.model ? CUSTOM : ""),
  );
  const [nozzle, setNozzle] = useState(
    String(
      BAMBU_NOZZLE_SIZES_MM.find((n) => n === current?.nozzleDiameterMm) ??
        DEFAULT_NOZZLE_MM,
    ),
  );
  const [customModel, setCustomModel] = useState(current?.model ?? "");
  const [customNozzle, setCustomNozzle] = useState(
    current?.nozzleDiameterMm != null ? String(current.nozzleDiameterMm) : "",
  );
  const [bedX, setBedX] = useState(
    current?.bedSizeMm ? String(current.bedSizeMm.x) : "",
  );
  const [bedY, setBedY] = useState(
    current?.bedSizeMm ? String(current.bedSizeMm.y) : "",
  );
  // Whether any printer field was interacted with — the signal that saving
  // should hit the override endpoint at all.
  const [printerTouched, setPrinterTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const touch = <T,>(set: (value: T) => void) => (value: T) => {
    setPrinterTouched(true);
    set(value);
  };

  const presetBed = choice && choice !== CUSTOM ? bedSizeForModel(choice) : null;
  const savePrinter = printer !== undefined && printerTouched && choice !== "";
  const canSave =
    !saving &&
    name.trim() !== "" &&
    !(savePrinter && choice === CUSTOM && customModel.trim() === "");

  function applyRename() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== base) onRename(`${trimmed}${ext}`);
  }

  async function handleSave() {
    if (!savePrinter || !printer) {
      applyRename();
      onClose();
      return;
    }
    const custom = choice === CUSTOM;
    const x = Number(bedX);
    const y = Number(bedY);
    const payload = {
      fileId: printer.fileId,
      model: custom ? customModel.trim() : choice,
      nozzleDiameterMm: custom
        ? customNozzle.trim()
          ? Number(customNozzle)
          : undefined
        : Number(nozzle),
      bedSizeMm: custom
        ? Number.isFinite(x) && x > 0 && Number.isFinite(y) && y > 0
          ? { x, y }
          : undefined
        : bedSizeForModel(choice),
    };
    setSaving(true);
    try {
      const res = await fetch(`/api/models/${printer.modelId}/printer-info`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Save failed (${res.status})`);
      toast.success(
        body.patched
          ? `Printer set to ${payload.model} — recalculating estimates.`
          : `Printer set to ${payload.model}. The file itself couldn't be updated, so downloads keep its original settings.`,
      );
      onPrinterSaved?.(body.printerInfo, body.size);
      applyRename();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit file</DialogTitle>
          <DialogDescription>
            {printer
              ? "Rename the file or set the printer it's meant for. Printer changes are written into the file right away; the new name is applied when you save the model."
              : "The new name is applied when you save the model."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="file-name">Filename</Label>
            <span className="flex items-center gap-1.5">
              <Input
                id="file-name"
                autoFocus
                className="min-w-0 flex-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {ext && <span className="shrink-0 text-muted-foreground">{ext}</span>}
            </span>
          </div>

          {printer && (
            <>
              <Separator />
              <div className="grid gap-2">
                <Label>Printer</Label>
                <Select value={choice} onValueChange={touch(setChoice)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a printer" />
                  </SelectTrigger>
                  <SelectContent>
                    {BAMBU_PRINTER_MODELS.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM}>Custom…</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {choice === CUSTOM && (
                <div className="grid gap-2">
                  <Label htmlFor="printer-model">Printer model</Label>
                  <Input
                    id="printer-model"
                    placeholder="e.g. Prusa CORE One"
                    value={customModel}
                    onChange={(e) => touch(setCustomModel)(e.target.value)}
                  />
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="printer-nozzle">Nozzle</Label>
                  {choice === CUSTOM ? (
                    <Input
                      id="printer-nozzle"
                      type="number"
                      step="0.1"
                      min="0.1"
                      max="2"
                      placeholder="0.4"
                      value={customNozzle}
                      onChange={(e) => touch(setCustomNozzle)(e.target.value)}
                    />
                  ) : (
                    <Select value={nozzle} onValueChange={touch(setNozzle)}>
                      <SelectTrigger id="printer-nozzle">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BAMBU_NOZZLE_SIZES_MM.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n} mm
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="printer-bed-x">Build plate (mm)</Label>
                  {choice === CUSTOM ? (
                    <div className="flex items-center gap-1.5">
                      <Input
                        id="printer-bed-x"
                        type="number"
                        min="20"
                        max="2000"
                        placeholder="X"
                        aria-label="Build plate width (mm)"
                        value={bedX}
                        onChange={(e) => touch(setBedX)(e.target.value)}
                      />
                      <span className="text-muted-foreground">×</span>
                      <Input
                        type="number"
                        min="20"
                        max="2000"
                        placeholder="Y"
                        aria-label="Build plate depth (mm)"
                        value={bedY}
                        onChange={(e) => touch(setBedY)(e.target.value)}
                      />
                    </div>
                  ) : (
                    <p
                      id="printer-bed-x"
                      className="flex h-9 items-center text-sm text-muted-foreground"
                    >
                      {presetBed ? `${presetBed.x} × ${presetBed.y}` : "—"}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSave} onClick={handleSave}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
