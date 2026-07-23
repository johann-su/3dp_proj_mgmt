"use client";

// The per-row "edit file" dialog of the wizard's model file list: rename the
// file, override the printer a stored .3mf itself is meant for, and manage
// its printer *derivatives* — copies of the file patched for other machines
// (issue #79), listed under "Printers" with add/remove.
//
// Persistence is split on purpose: the name is form state applied with the
// model's "Save changes" (like the old inline rename), while printer
// operations (override / add / remove derivative) save immediately through
// /api/models/[id]/printer-info, because they rewrite or create stored
// archives and re-queue slicing. The main view's Save never touches printers,
// so a plain rename cannot trigger a re-slice.

import { useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, Printer as PrinterIcon, X } from "lucide-react";
import type { PrinterInfo } from "@/db/schema";
import { bedSizeForModel } from "@/lib/printer-beds";
import {
  BAMBU_NOZZLE_SIZES_MM,
  BAMBU_PRINTER_MODELS,
  DEFAULT_NOZZLE_MM,
  shortPrinterLabel,
} from "@/lib/printer-presets";
import { splitExtension, type DerivativeFile } from "./model-form-state";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const CUSTOM = "custom";

type OverridePayload = {
  model: string;
  nozzleDiameterMm?: number;
  bedSizeMm?: { x: number; y: number };
};

// The preset/custom printer fields, shared by "edit this file's printer" and
// "add a derivative". Owns its field state; the caller does the fetch.
function PrinterForm({
  initial,
  submitLabel,
  saving,
  onSubmit,
  onBack,
}: {
  // Prefill (the file's current profile when editing; null for a fresh add).
  initial: PrinterInfo | null;
  submitLabel: string;
  saving: boolean;
  onSubmit: (payload: OverridePayload) => void;
  onBack: () => void;
}) {
  const knownModel = BAMBU_PRINTER_MODELS.find((m) => m === initial?.model);
  const [choice, setChoice] = useState<string>(
    knownModel ?? (initial?.model ? CUSTOM : ""),
  );
  const [nozzle, setNozzle] = useState(
    String(
      BAMBU_NOZZLE_SIZES_MM.find((n) => n === initial?.nozzleDiameterMm) ??
        DEFAULT_NOZZLE_MM,
    ),
  );
  const [customModel, setCustomModel] = useState(initial?.model ?? "");
  const [customNozzle, setCustomNozzle] = useState(
    initial?.nozzleDiameterMm != null ? String(initial.nozzleDiameterMm) : "",
  );
  const [bedX, setBedX] = useState(
    initial?.bedSizeMm ? String(initial.bedSizeMm.x) : "",
  );
  const [bedY, setBedY] = useState(
    initial?.bedSizeMm ? String(initial.bedSizeMm.y) : "",
  );

  const presetBed = choice && choice !== CUSTOM ? bedSizeForModel(choice) : null;
  const canSubmit =
    !saving && (choice === CUSTOM ? customModel.trim() !== "" : choice !== "");

  function submit() {
    const custom = choice === CUSTOM;
    const x = Number(bedX);
    const y = Number(bedY);
    onSubmit({
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
    });
  }

  return (
    <>
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
              <p
                id="printer-bed-x"
                className="flex h-9 items-center text-sm text-muted-foreground"
              >
                {presetBed ? `${presetBed.x} × ${presetBed.y}` : "—"}
              </p>
            )}
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onBack}>
          Back
        </Button>
        <Button type="button" disabled={!canSubmit} onClick={submit}>
          {saving ? "Saving…" : submitLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

function printerLine(info: PrinterInfo | null): string {
  if (!info?.model) return "No printer set";
  const nozzle =
    info.nozzleDiameterMm != null ? ` · ${info.nozzleDiameterMm} mm` : "";
  return `${shortPrinterLabel(info.model)}${nozzle}`;
}

export function ModelFileEditDialog({
  filename,
  printer,
  onClose,
  onRename,
  onPrinterSaved,
  onDerivativeAdded,
  onDerivativeRemoved,
}: {
  filename: string;
  // Present only when printers may be edited (a stored .3mf): the file's own
  // profile plus its derivatives — the dialog opens reflecting them.
  printer?: {
    modelId: string;
    fileId: string;
    current: PrinterInfo | null;
    derivatives: DerivativeFile[];
  };
  onClose: () => void;
  onRename: (newName: string) => void;
  onPrinterSaved?: (info: PrinterInfo, size: number) => void;
  onDerivativeAdded?: (derivative: DerivativeFile) => void;
  onDerivativeRemoved?: (derivativeId: string) => void;
}) {
  const [base, ext] = splitExtension(filename);
  const [name, setName] = useState(base);
  // "main" lists printers; the form edits this file's printer ("self") or
  // adds a derivative ("add").
  const [view, setView] = useState<"main" | "self" | "add">("main");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  function applyRename() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== base) onRename(`${trimmed}${ext}`);
  }

  async function callEndpoint(method: "PATCH" | "POST" | "DELETE", body: object) {
    const res = await fetch(`/api/models/${printer!.modelId}/printer-info`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
    return json;
  }

  async function submitPrinter(payload: OverridePayload) {
    if (!printer) return;
    setSaving(true);
    try {
      if (view === "self") {
        const body = await callEndpoint("PATCH", {
          fileId: printer.fileId,
          ...payload,
        });
        toast.success(
          body.patched
            ? `Printer set to ${payload.model} — recalculating estimates.`
            : `Printer set to ${payload.model}. The file itself couldn't be updated, so downloads keep its original settings.`,
        );
        onPrinterSaved?.(body.printerInfo, body.size);
      } else {
        const body = await callEndpoint("POST", {
          fileId: printer.fileId,
          ...payload,
        });
        toast.success(`Added ${body.file.filename} — estimating its print.`);
        onDerivativeAdded?.(body.file);
      }
      setView("main");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function removeDerivative(derivative: DerivativeFile) {
    setRemovingId(derivative.id);
    try {
      await callEndpoint("DELETE", { fileId: derivative.id });
      toast.success(`Removed ${derivative.filename}.`);
      onDerivativeRemoved?.(derivative.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit file</DialogTitle>
          <DialogDescription>
            {printer
              ? "Rename the file or manage the printers it's available for. Printer changes apply right away; the new name is applied when you save the model."
              : "The new name is applied when you save the model."}
          </DialogDescription>
        </DialogHeader>

        {view === "main" ? (
          <>
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
                  {ext && (
                    <span className="shrink-0 text-muted-foreground">{ext}</span>
                  )}
                </span>
              </div>

              {printer && (
                <>
                  <Separator />
                  <div className="grid gap-2">
                    <Label>Printers</Label>
                    <ul className="grid gap-1">
                      <li className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm">
                        <PrinterIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">
                          {printerLine(printer.current)}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          this file
                        </span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="ml-auto size-6 shrink-0"
                              aria-label="Edit this file's printer"
                              onClick={() => setView("self")}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            Edit this file&apos;s printer
                          </TooltipContent>
                        </Tooltip>
                      </li>
                      {printer.derivatives.map((derivative) => (
                        <li
                          key={derivative.id}
                          className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-sm"
                        >
                          <PrinterIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">
                            {printerLine(derivative.printerInfo)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {derivative.filename}
                          </span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-6 shrink-0"
                                aria-label={`Remove ${derivative.filename}`}
                                disabled={removingId !== null}
                                onClick={() => removeDerivative(derivative)}
                              >
                                <X className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Remove this printer</TooltipContent>
                          </Tooltip>
                        </li>
                      ))}
                    </ul>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-self-start"
                      onClick={() => setView("add")}
                    >
                      <Plus className="size-3.5" />
                      Add printer
                    </Button>
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={name.trim() === ""}
                onClick={() => {
                  applyRename();
                  onClose();
                }}
              >
                Save
              </Button>
            </DialogFooter>
          </>
        ) : (
          <PrinterForm
            key={view}
            initial={view === "self" ? (printer?.current ?? null) : null}
            submitLabel={view === "self" ? "Apply" : "Add printer"}
            saving={saving}
            onSubmit={submitPrinter}
            onBack={() => setView("main")}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
