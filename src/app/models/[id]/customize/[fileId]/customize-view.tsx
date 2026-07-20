"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, RotateCcw, Wand2 } from "lucide-react";
import type { ScadParameter, ScadParameterGroup } from "@/lib/scad-params";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScadPreview } from "./scad-preview";

type Values = Record<string, unknown>;

function defaultValues(groups: ScadParameterGroup[]): Values {
  const values: Values = {};
  for (const group of groups) {
    for (const param of group.parameters) values[param.name] = param.default;
  }
  return values;
}

function ParameterField({
  param,
  value,
  onChange,
}: {
  param: ScadParameter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `scad-param-${param.name}`;

  if (param.type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          className="size-4 accent-primary"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <Label htmlFor={id} className="text-sm font-normal">
          {param.description ?? param.name.replace(/_/g, " ")}
        </Label>
      </div>
    );
  }

  const label = (
    <Label htmlFor={id} className="text-xs">
      {param.name.replace(/_/g, " ")}
      {param.description && (
        <span className="ml-1 font-normal text-muted-foreground">
          — {param.description}
        </span>
      )}
    </Label>
  );

  if ((param.type === "number" || param.type === "string") && param.options) {
    return (
      <div className="grid gap-1">
        {label}
        <Select
          value={String(value)}
          onValueChange={(v) => onChange(param.type === "number" ? Number(v) : v)}
        >
          <SelectTrigger id={id} className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {param.options.map((option) => (
              <SelectItem key={String(option.value)} value={String(option.value)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (param.type === "number") {
    const hasRange = param.min !== undefined && param.max !== undefined;
    return (
      <div className="grid gap-1">
        {label}
        <div className="flex items-center gap-2">
          {hasRange && (
            <input
              type="range"
              className="min-w-0 flex-1 accent-primary"
              min={param.min}
              max={param.max}
              step={param.step ?? (Number.isInteger(param.default) ? 1 : 0.1)}
              value={Number(value)}
              onChange={(e) => onChange(Number(e.target.value))}
            />
          )}
          <Input
            id={id}
            type="number"
            className={hasRange ? "w-24" : "w-36"}
            min={param.min}
            max={param.max}
            step={param.step}
            value={String(value)}
            onChange={(e) => onChange(e.target.valueAsNumber)}
          />
        </div>
      </div>
    );
  }

  if (param.type === "vector") {
    const vector = Array.isArray(value) ? value : param.default;
    return (
      <div className="grid gap-1">
        {label}
        <div className="flex gap-2">
          {vector.map((component: unknown, i: number) => (
            <Input
              key={i}
              type="number"
              className="w-20"
              min={param.min}
              max={param.max}
              step={param.step}
              value={String(component)}
              onChange={(e) => {
                const next = [...vector];
                next[i] = e.target.valueAsNumber;
                onChange(next);
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-1">
      {label}
      <Input
        id={id}
        maxLength={param.maxLength}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// How long after the last parameter change the preview re-renders. Long
// enough to survive slider drags, short enough to feel live.
const PREVIEW_DEBOUNCE_MS = 800;

// Parameter panel width (px) on the lg row layout. Clamped so it can't shrink
// past readability or grow big enough to crowd out the preview.
const PANEL_DEFAULT_WIDTH = 384; // matches the previous fixed lg:w-96
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 720;
const PANEL_WIDTH_KEY = "scad-customizer-panel-width";

function clampPanelWidth(width: number) {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width));
}

export function CustomizeView({
  modelId,
  modelTitle,
  fileId,
  filename,
  groups,
}: {
  modelId: string;
  modelTitle: string;
  fileId: string;
  filename: string;
  groups: ScadParameterGroup[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(() => defaultValues(groups));
  const [previewData, setPreviewData] = useState<ArrayBuffer | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Monotonic counter so a slow older render can't overwrite a newer one.
  const previewSeq = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const asideRef = useRef<HTMLElement | null>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const resizing = useRef(false);

  // Restore the last dragged width once mounted (avoids SSR/localStorage skew).
  useEffect(() => {
    const stored = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) setPanelWidth(clampPanelWidth(stored));
  }, []);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!resizing.current || !asideRef.current) return;
      const left = asideRef.current.getBoundingClientRect().left;
      setPanelWidth(clampPanelWidth(e.clientX - left));
    }
    function onUp() {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [panelWidth]);

  const runPreview = useCallback(
    async (previewValues: Values) => {
      const seq = ++previewSeq.current;
      setPreviewing(true);
      setPreviewError(null);
      try {
        const res = await fetch(`/api/models/${modelId}/customize/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileId, values: previewValues }),
        });
        if (seq !== previewSeq.current) return; // superseded by a newer render
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setPreviewError(body?.error ?? `Preview failed (${res.status})`);
          return;
        }
        setPreviewData(await res.arrayBuffer());
      } catch {
        if (seq === previewSeq.current) setPreviewError("Preview failed — is the OpenSCAD service running?");
      } finally {
        if (seq === previewSeq.current) setPreviewing(false);
      }
    },
    [modelId, fileId],
  );

  // First render on mount, then re-render debounced on every change.
  useEffect(() => {
    runPreview(defaultValues(groups));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateValue(name: string, value: unknown) {
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(
        () => runPreview(next),
        PREVIEW_DEBOUNCE_MS,
      );
      return next;
    });
  }

  function resetDefaults() {
    const defaults = defaultValues(groups);
    setValues(defaults);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    runPreview(defaults);
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const res = await fetch(`/api/models/${modelId}/customize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId, values }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? `Rendering failed (${res.status})`);
      }
      if (body?.status === "exists") {
        toast.message(`Already generated as “${body.filename}”.`);
      } else {
        toast.success(`Generated “${body.filename}” — added to the model's files.`);
      }
      // Back to the model page, where the new variant is listed for download.
      router.push(`/models/${modelId}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rendering failed");
      setGenerating(false);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col lg:flex-row">
      <aside
        ref={asideRef}
        style={{ "--panel-width": `${panelWidth}px` } as React.CSSProperties}
        className="relative flex min-h-0 flex-col border-b lg:w-[var(--panel-width)] lg:shrink-0 lg:border-b-0 lg:border-r order-2 lg:order-1"
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon" className="shrink-0">
                <Link href={`/models/${modelId}`} aria-label="Back to model">
                  <ArrowLeft className="size-4" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Back to model</TooltipContent>
          </Tooltip>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{modelTitle}</div>
            <div className="truncate text-xs text-muted-foreground">{filename}</div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="grid gap-5">
            {groups.map((group, groupIndex) => (
              <div key={group.name ?? groupIndex} className="grid gap-3">
                {group.name && (
                  <>
                    {groupIndex > 0 && <Separator />}
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.name}
                    </div>
                  </>
                )}
                {group.parameters.map((param) => (
                  <ParameterField
                    key={param.name}
                    param={param}
                    value={values[param.name]}
                    onChange={(value) => updateValue(param.name, value)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t px-4 py-3">
          <Button
            className="flex-1"
            disabled={generating || previewing}
            onClick={handleGenerate}
          >
            {generating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wand2 className="size-4" />
            )}
            {generating ? "Rendering…" : "Generate .3mf"}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                disabled={generating}
                onClick={resetDefaults}
                aria-label="Reset parameters to defaults"
              >
                <RotateCcw className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reset parameters to defaults</TooltipContent>
          </Tooltip>
        </div>

        {/* Drag to resize the panel width (lg row layout only). */}
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startResize}
          className="group absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none lg:block"
        >
          <div className="mx-auto h-full w-1 rounded-full bg-transparent transition-colors group-hover:bg-primary/80" />
        </div>
      </aside>

      <div className="order-1 flex min-h-[45dvh] flex-1 lg:order-2 lg:min-h-0">
        <ScadPreview data={previewData} rendering={previewing} error={previewError} />
      </div>
    </div>
  );
}
