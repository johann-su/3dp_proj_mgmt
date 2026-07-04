"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, FileBox, ImageIcon, X } from "lucide-react";
import { createModel, type UploadedFile } from "@/app/models/actions";
import { extract3mfMetadata } from "@/lib/threemf";
import type { BomItemInput } from "@/lib/bom";
import { BomEditor } from "./bom-editor";
import { cn, isNextRedirectError } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Category = { id: string; name: string; slug: string };

const MODEL_ACCEPT = ".3mf,.stl,.step,.stp";
const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";

async function uploadFile(file: File, kind: "model" | "image"): Promise<UploadedFile> {
  const params = new URLSearchParams({ filename: file.name, kind });
  const res = await fetch(`/api/upload?${params}`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Upload failed for ${file.name}`);
  }
  return res.json();
}

function FilePicker({
  label,
  hint,
  accept,
  files,
  setFiles,
  onFilesAdded,
  icon,
}: {
  label?: string;
  hint: string;
  accept: string;
  files: File[];
  setFiles: (files: File[]) => void;
  onFilesAdded?: (added: File[]) => void;
  icon: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="grid gap-2">
      {label && <Label>{label}</Label>}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length > 0) {
            setFiles([...files, ...picked]);
            onFilesAdded?.(picked);
          }
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="border border-dashed rounded-lg p-6 text-sm text-muted-foreground hover:bg-accent/50 transition-colors flex flex-col items-center gap-2"
      >
        {icon}
        {hint}
      </button>
      {files.length > 0 && (
        <ul className="grid gap-1">
          {files.map((file, i) => (
            <li
              key={`${file.name}-${i}`}
              className="flex items-center gap-2 text-sm border rounded-md px-3 py-2"
            >
              <span className="truncate">{file.name}</span>
              <span className="text-muted-foreground ml-auto shrink-0">
                {formatBytes(file.size)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StepIndicator({ step }: { step: 1 | 2 }) {
  return (
    <ol className="flex items-center gap-3 text-sm mb-6">
      {(
        [
          [1, "Files"],
          [2, "Details"],
        ] as const
      ).map(([n, name], i) => (
        <li key={n} className="flex items-center gap-3">
          {i > 0 && <span className="w-8 h-px bg-border" />}
          <span
            className={cn(
              "flex items-center gap-2",
              step === n ? "font-medium" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "size-5 rounded-full flex items-center justify-center text-xs",
                step === n
                  ? "bg-primary text-primary-foreground"
                  : "border text-muted-foreground",
              )}
            >
              {n}
            </span>
            {name}
          </span>
        </li>
      ))}
    </ol>
  );
}

function mergeTags(existing: string, addition: string) {
  const current = existing
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (current.some((t) => t.toLowerCase() === addition.toLowerCase())) {
    return existing;
  }
  return [...current, addition].join(", ");
}

export function NewModelForm({ categories }: { categories: Category[] }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [modelFiles, setModelFiles] = useState<File[]>([]);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [categoryId, setCategoryId] = useState<string>("");
  const [bom, setBom] = useState<BomItemInput[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(0);

  async function importFrom3mf(added: File[]) {
    for (const file of added) {
      if (!file.name.toLowerCase().endsWith(".3mf")) continue;
      setExtracting((n) => n + 1);
      try {
        const meta = await extract3mfMetadata(file);
        if (meta.title) {
          setTitle((prev) => (prev.trim() ? prev : meta.title!));
        }
        if (meta.description) {
          setDescription((prev) => (prev.trim() ? prev : meta.description!));
        }
        if (meta.printerTag) {
          setTags((prev) => mergeTags(prev, meta.printerTag!));
        }
        if (meta.images.length > 0) {
          setImageFiles((prev) => {
            const known = new Set(prev.map((f) => `${f.name}:${f.size}`));
            const fresh = meta.images.filter((f) => !known.has(`${f.name}:${f.size}`));
            return [...prev, ...fresh];
          });
        }
        if (meta.title || meta.description || meta.printerTag || meta.images.length > 0) {
          toast.success(`Imported metadata from ${file.name}`);
        }
      } catch (err) {
        // Best effort — a 3mf we can't read is still a valid upload.
        console.warn(`Could not extract metadata from ${file.name}`, err);
      } finally {
        setExtracting((n) => n - 1);
      }
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (modelFiles.length === 0) {
      toast.error("Add at least one model file (.3mf / .step / .stl)");
      setStep(1);
      return;
    }

    try {
      const toUpload: { file: File; kind: "model" | "image" }[] = [
        ...modelFiles.map((file) => ({ file, kind: "model" as const })),
        ...imageFiles.map((file) => ({ file, kind: "image" as const })),
      ];
      const uploaded: UploadedFile[] = [];
      for (const [i, { file, kind }] of toUpload.entries()) {
        setStatus(`Uploading ${i + 1}/${toUpload.length}: ${file.name}`);
        uploaded.push(await uploadFile(file, kind));
      }

      setStatus("Creating model…");
      // On success createModel redirects (handled by Next); it only returns
      // a value when something went wrong.
      const result = await createModel({
        title,
        description,
        categoryId: categoryId || null,
        tags: tags.split(","),
        files: uploaded,
        bom,
      });
      if (result?.error) {
        setStatus(null);
        toast.error(result.error);
      }
    } catch (err) {
      if (isNextRedirectError(err)) return;
      setStatus(null);
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-6">
      <StepIndicator step={step} />

      {step === 1 && (
        <>
          <FilePicker
            hint="Click to add .3mf / .step / .stl files — title, description, images and printer are imported from .3mf automatically"
            accept={MODEL_ACCEPT}
            files={modelFiles}
            setFiles={setModelFiles}
            onFilesAdded={importFrom3mf}
            icon={<FileBox className="size-6" />}
          />
          <Button
            type="button"
            className="justify-self-end"
            disabled={modelFiles.length === 0 || extracting > 0}
            onClick={() => setStep(2)}
          >
            {extracting > 0 ? "Reading metadata…" : "Continue"}
            <ArrowRight className="size-4" />
          </Button>
        </>
      )}

      {step === 2 && (
        <>
          <div className="grid gap-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              name="title"
              required
              placeholder="e.g. Parametric cable clip"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              name="description"
              rows={6}
              placeholder="What is it, how to print it, material recommendations…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2 sm:gap-4">
            <div className="grid gap-2">
              <Label>Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tags">Tags</Label>
              <Input
                id="tags"
                name="tags"
                placeholder="comma, separated, tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </div>
          </div>

          <BomEditor items={bom} setItems={setBom} />

          <FilePicker
            label="Images"
            hint="Click to add preview images"
            accept={IMAGE_ACCEPT}
            files={imageFiles}
            setFiles={setImageFiles}
            icon={<ImageIcon className="size-6" />}
          />

          <div className="flex justify-between">
            <Button
              type="button"
              variant="outline"
              disabled={status !== null}
              onClick={() => setStep(1)}
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <Button type="submit" disabled={status !== null}>
              {status ?? "Create model"}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
