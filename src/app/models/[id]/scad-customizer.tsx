"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Loader2, RotateCcw, Wand2 } from "lucide-react";
import type { ScadParameter, ScadParameterGroup } from "@/lib/scad-params";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
          {param.description ?? param.name}
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
          onValueChange={(v) =>
            onChange(param.type === "number" ? Number(v) : v)
          }
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

// Customizer panel for a parametric .scad model file: one field per
// customizer parameter, grouped by /* [Section] */ headers. Generating posts
// to /api/models/[id]/customize, which renders via the OpenSCAD service and
// stores the result as a .3mf variant of this file.
export function ScadCustomizer({
  modelId,
  fileId,
  groups,
}: {
  modelId: string;
  fileId: string;
  groups: ScadParameterGroup[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>(() => defaultValues(groups));
  const [generating, setGenerating] = useState(false);

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
        toast.success(`Generated “${body.filename}”.`);
        setOpen(false);
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rendering failed");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="outline" size="sm" className="w-full">
          <Wand2 className="size-4" />
          Customize
          <ChevronDown
            className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 grid gap-4 rounded-lg border p-3">
          {groups.map((group, groupIndex) => (
            <div key={group.name ?? groupIndex} className="grid gap-3">
              {group.name && (
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.name}
                </div>
              )}
              {group.parameters.map((param) => (
                <ParameterField
                  key={param.name}
                  param={param}
                  value={values[param.name]}
                  onChange={(value) =>
                    setValues((prev) => ({ ...prev, [param.name]: value }))
                  }
                />
              ))}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={generating} onClick={handleGenerate}>
              {generating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Wand2 className="size-4" />
              )}
              {generating ? "Rendering… this can take a minute" : "Generate .3mf"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={generating}
              onClick={() => setValues(defaultValues(groups))}
            >
              <RotateCcw className="size-4" />
              Reset
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
