"use client";

// The per-file "edit printer info" dialog (issue #79), opened from a .3mf row
// in the edit form's file list. A preset (or the Custom fields) is saved
// immediately through PATCH /api/models/[id]/printer-info — not with the form
// submit — because saving rewrites the stored archive and re-queues slicing.

import { useState } from "react";
import { toast } from "sonner";
import type { PrinterInfo } from "@/db/schema";
import { bedSizeForModel } from "@/lib/printer-beds";
import {
  BAMBU_NOZZLE_SIZES_MM,
  BAMBU_PRINTER_MODELS,
  DEFAULT_NOZZLE_MM,
} from "@/lib/printer-presets";
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

const CUSTOM = "custom";

export function PrinterInfoDialog({
  modelId,
  fileId,
  filename,
  current,
  onClose,
  onSaved,
}: {
  modelId: string;
  fileId: string;
  filename: string;
  // The file's stored profile — the dialog opens reflecting it, not blank.
  current: PrinterInfo | null;
  onClose: () => void;
  onSaved: (info: PrinterInfo, size: number) => void;
}) {
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
  const [saving, setSaving] = useState(false);

  const presetBed = choice && choice !== CUSTOM ? bedSizeForModel(choice) : null;
  const canSave =
    !saving && (choice === CUSTOM ? customModel.trim() !== "" : choice !== "");

  async function handleSave() {
    const custom = choice === CUSTOM;
    const x = Number(bedX);
    const y = Number(bedY);
    const payload = {
      fileId,
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
      const res = await fetch(`/api/models/${modelId}/printer-info`, {
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
      onSaved(body.printerInfo, body.size);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit printer info</DialogTitle>
          <DialogDescription>
            Set the printer “{filename}” is meant for. The choice is written
            into the file and its print estimates are recalculated.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Printer</Label>
            <Select value={choice} onValueChange={setChoice}>
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
                onChange={(e) => setCustomModel(e.target.value)}
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
                  onChange={(e) => setCustomNozzle(e.target.value)}
                />
              ) : (
                <Select value={nozzle} onValueChange={setNozzle}>
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
                    onChange={(e) => setBedX(e.target.value)}
                  />
                  <span className="text-muted-foreground">×</span>
                  <Input
                    type="number"
                    min="20"
                    max="2000"
                    placeholder="Y"
                    aria-label="Build plate depth (mm)"
                    value={bedY}
                    onChange={(e) => setBedY(e.target.value)}
                  />
                </div>
              ) : (
                <p id="printer-bed-x" className="flex h-9 items-center text-sm text-muted-foreground">
                  {presetBed ? `${presetBed.x} × ${presetBed.y}` : "—"}
                </p>
              )}
            </div>
          </div>
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
