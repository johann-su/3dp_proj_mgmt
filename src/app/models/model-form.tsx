"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Eye,
  FileBox,
  FileText,
  ImageIcon,
  Pencil,
  X,
} from "lucide-react";
import {
  createModel,
  updateModel,
  type ImageOrderRef,
  type UploadedFile,
} from "@/app/models/actions";
import { extract3mfMetadata } from "@/lib/threemf";
import type { BomItemInput } from "@/lib/bom";
import { IMPORT_DRAFT_KEY, type ImportDraftPayload } from "./import-draft";
import { BomEditor } from "./bom-editor";
import { ModelPreview } from "./model-preview";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

type Category = { id: string; name: string; slug: string };

export type ExistingFile = {
  id: string;
  filename: string;
  size: number;
  kind: "model" | "image" | "pdf";
};

// Prefilled values when editing; absent when creating a new model.
export type ModelFormInitial = {
  id: string;
  title: string;
  description: string;
  categoryId: string | null;
  tags: string[];
  bom: BomItemInput[];
  files: ExistingFile[];
  createdAt: Date;
};

// One image in the wizard, in display order: already stored on the model
// (edit mode), staged in S3 by a URL import (create mode), or freshly
// picked (src is an object URL then).
type ImageEntry = {
  key: string;
  src: string;
  filename: string;
  size: number;
} & (
  | { type: "existing"; id: string }
  | { type: "staged"; staged: UploadedFile }
  | { type: "new"; file: File }
);

function newImageEntry(file: File): ImageEntry {
  return {
    key: crypto.randomUUID(),
    type: "new",
    file,
    src: URL.createObjectURL(file),
    filename: file.name,
    size: file.size,
  };
}

function stagedImageEntry(file: UploadedFile): ImageEntry {
  return {
    key: file.key,
    type: "staged",
    staged: file,
    src: `/api/uploads/preview?key=${encodeURIComponent(file.key)}`,
    filename: file.filename,
    size: file.size,
  };
}

const MODEL_ACCEPT = ".3mf";
const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";
const PDF_ACCEPT = ".pdf";

// A model/pdf file picked in the browser but not yet uploaded. Carries a
// stable key (for React lists, and so a rename can target one entry) and an
// editable display name independent of the underlying File's read-only name.
type PendingFile = { key: string; file: File; name: string };

function pendingFile(file: File): PendingFile {
  return { key: crypto.randomUUID(), file, name: file.name };
}

// A name has no extension to preserve if there's no dot, or the dot is the
// first character (a dotfile like ".gitignore").
function splitExtension(name: string): [base: string, ext: string] {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
}

async function uploadFile(
  file: File,
  kind: "model" | "image" | "pdf",
  filename: string = file.name,
): Promise<UploadedFile> {
  const params = new URLSearchParams({ filename, kind });
  const res = await fetch(`/api/upload?${params}`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Upload failed for ${filename}`);
  }
  return res.json();
}

function FileRow({
  name,
  size,
  imported,
  onRemove,
  onRename,
}: {
  name: string;
  size: number;
  // Marks files pulled in by URL import (already staged in S3).
  imported?: boolean;
  onRemove: () => void;
  // Omitted where renaming doesn't apply (e.g. images, PDFs).
  onRename?: (newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftBase, setDraftBase] = useState("");
  const [base, ext] = splitExtension(name);

  function commit() {
    setEditing(false);
    const trimmed = draftBase.trim();
    if (trimmed && trimmed !== base) onRename?.(`${trimmed}${ext}`);
  }

  return (
    <li className="flex min-w-0 items-center gap-2 text-sm border rounded-md px-3 py-2">
      {imported && <CloudDownload className="size-3.5 text-primary shrink-0" />}
      {editing ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <Input
            autoFocus
            aria-label={`New name for ${name}`}
            value={draftBase}
            onChange={(e) => setDraftBase(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            className="h-6 min-w-0 flex-1 px-1"
          />
          <span className="shrink-0 text-muted-foreground">{ext}</span>
        </span>
      ) : (
        <span className="truncate">{name}</span>
      )}
      <span className="text-muted-foreground ml-auto shrink-0">
        {formatBytes(size)}
      </span>
      {onRename && !editing && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label={`Rename ${name}`}
          onClick={() => {
            setDraftBase(base);
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </li>
  );
}

function FilePicker({
  label,
  hint,
  accept,
  files,
  setFiles,
  existing,
  removeExisting,
  renameExisting,
  staged,
  removeStaged,
  renameStaged,
  onFilesAdded,
  onRenameNew,
  icon,
}: {
  label?: string;
  hint: string;
  accept: string;
  files: PendingFile[];
  setFiles: (files: PendingFile[]) => void;
  existing?: ExistingFile[];
  removeExisting?: (id: string) => void;
  renameExisting?: (id: string, name: string) => void;
  // Files pulled in by URL import — already staged in S3.
  staged?: UploadedFile[];
  removeStaged?: (key: string) => void;
  renameStaged?: (key: string, name: string) => void;
  onFilesAdded?: (added: File[]) => void;
  onRenameNew?: (key: string, name: string) => void;
  icon: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasFiles =
    files.length > 0 || (existing?.length ?? 0) > 0 || (staged?.length ?? 0) > 0;

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
            setFiles([...files, ...picked.map(pendingFile)]);
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
      {hasFiles && (
        <ul className="grid gap-1">
          {existing?.map((file) => (
            <FileRow
              key={file.id}
              name={file.filename}
              size={file.size}
              onRemove={() => removeExisting?.(file.id)}
              onRename={
                renameExisting ? (name) => renameExisting(file.id, name) : undefined
              }
            />
          ))}
          {staged?.map((file) => (
            <FileRow
              key={file.key}
              name={file.filename}
              size={file.size}
              imported
              onRemove={() => removeStaged?.(file.key)}
              onRename={
                renameStaged ? (name) => renameStaged(file.key, name) : undefined
              }
            />
          ))}
          {files.map((entry) => (
            <FileRow
              key={entry.key}
              name={entry.name}
              size={entry.file.size}
              onRemove={() => setFiles(files.filter((f) => f.key !== entry.key))}
              onRename={
                onRenameNew ? (name) => onRenameNew(entry.key, name) : undefined
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ImagePicker({
  images,
  onAdd,
  onRemove,
  onMove,
  onReorder,
}: {
  images: ImageEntry[];
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onReorder: (key: string, targetKey: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);

  return (
    <div className="grid gap-2">
      <Label>Images</Label>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length > 0) onAdd(picked);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="border border-dashed rounded-lg p-6 text-sm text-muted-foreground hover:bg-accent/50 transition-colors flex flex-col items-center gap-2"
      >
        <ImageIcon className="size-6" />
        Click to add preview images — the first image is the cover, drag
        thumbnails to reorder
      </button>
      {images.length > 0 && (
        <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {images.map((image, i) => (
            <li
              key={image.key}
              className={cn(
                "relative rounded-md border overflow-hidden bg-muted cursor-grab",
                draggedKey === image.key && "opacity-50",
              )}
              title={`${image.filename} (${formatBytes(image.size)})`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                setDraggedKey(image.key);
              }}
              onDragEnd={() => setDraggedKey(null)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={() => {
                if (draggedKey && draggedKey !== image.key) {
                  onReorder(draggedKey, image.key);
                }
              }}
              onDrop={(e) => e.preventDefault()}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.src}
                alt={image.filename}
                className="aspect-square w-full object-cover"
              />
              {i === 0 && (
                <span className="absolute top-1 left-1 rounded bg-primary text-primary-foreground text-[10px] font-medium px-1.5 py-0.5">
                  Cover
                </span>
              )}
              {image.type === "staged" && (
                <span
                  className="absolute top-1 right-1 rounded bg-primary text-primary-foreground p-1"
                  title="Imported from source"
                >
                  <CloudDownload className="size-3" />
                </span>
              )}
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between p-1 bg-gradient-to-t from-black/60 to-transparent">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="size-6"
                  aria-label={`Move ${image.filename} left`}
                  disabled={i === 0}
                  onClick={() => onMove(image.key, -1)}
                >
                  <ChevronLeft className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="size-6"
                  aria-label={`Remove ${image.filename}`}
                  onClick={() => onRemove(image.key)}
                >
                  <X className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="size-6"
                  aria-label={`Move ${image.filename} right`}
                  disabled={i === images.length - 1}
                  onClick={() => onMove(image.key, 1)}
                >
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StepIndicator({
  step,
  canGoToDetails,
  onSelect,
}: {
  step: 1 | 2;
  canGoToDetails: boolean;
  onSelect: (step: 1 | 2) => void;
}) {
  return (
    <ol className="flex items-center gap-3 text-sm mb-6">
      {(
        [
          [1, "Files"],
          [2, "Details"],
        ] as const
      ).map(([n, name], i) => {
        const disabled = n === 2 && !canGoToDetails;
        return (
          <li key={n} className="flex items-center gap-3">
            {i > 0 && <span className="w-8 h-px bg-border" />}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect(n)}
              className={cn(
                "flex items-center gap-2 rounded disabled:cursor-not-allowed disabled:opacity-50",
                step === n
                  ? "font-medium"
                  : "text-muted-foreground hover:text-foreground",
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
            </button>
          </li>
        );
      })}
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

export function ModelForm({
  categories,
  userName,
  model,
}: {
  categories: Category[];
  userName: string;
  model?: ModelFormInitial;
}) {
  const router = useRouter();
  const cancelHref = model ? `/models/${model.id}` : "/models/mine";
  const [step, setStep] = useState<1 | 2>(1);
  const [preview, setPreview] = useState(false);
  const [title, setTitle] = useState(model?.title ?? "");
  const [description, setDescription] = useState(model?.description ?? "");
  const [tags, setTags] = useState(model?.tags.join(", ") ?? "");
  const [existingModelFiles, setExistingModelFiles] = useState<ExistingFile[]>(
    () => model?.files.filter((f) => f.kind === "model") ?? [],
  );
  const [modelFiles, setModelFiles] = useState<PendingFile[]>([]);
  const [existingPdfFiles, setExistingPdfFiles] = useState<ExistingFile[]>(
    () => model?.files.filter((f) => f.kind === "pdf") ?? [],
  );
  const [pdfFiles, setPdfFiles] = useState<PendingFile[]>([]);
  const [images, setImages] = useState<ImageEntry[]>(() =>
    (model?.files ?? [])
      .filter((f) => f.kind === "image")
      .map((f) => ({
        key: f.id,
        type: "existing",
        id: f.id,
        src: `/api/files/${f.id}`,
        filename: f.filename,
        size: f.size,
      })),
  );
  const [categoryId, setCategoryId] = useState<string>(model?.categoryId ?? "");
  const [bom, setBom] = useState<BomItemInput[]>(model?.bom ?? []);
  const [status, setStatus] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(0);

  // Model files pulled in by URL import (already staged in S3) and the source
  // link, only used when creating a new model. Staged images live in `images`.
  const [stagedModelFiles, setStagedModelFiles] = useState<UploadedFile[]>([]);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [onshapeMicroversion, setOnshapeMicroversion] = useState<string | null>(null);

  const hasModelFile =
    existingModelFiles.length > 0 ||
    modelFiles.length > 0 ||
    stagedModelFiles.length > 0;

  // Hydrate from an import draft handed over by /models/import. Create mode
  // only; runs once after hydration (sessionStorage is client-only).
  useEffect(() => {
    if (model) return;
    const raw = sessionStorage.getItem(IMPORT_DRAFT_KEY);
    if (!raw) return;
    sessionStorage.removeItem(IMPORT_DRAFT_KEY);
    try {
      const draft = JSON.parse(raw) as ImportDraftPayload;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle(draft.title ?? "");
      setDescription(draft.description ?? "");
      setTags((draft.tags ?? []).join(", "));
      setSourceUrl(draft.sourceUrl ?? null);
      setOnshapeMicroversion(draft.onshapeMicroversion ?? null);
      setStagedModelFiles((draft.files ?? []).filter((f) => f.kind === "model"));
      setImages(
        (draft.files ?? [])
          .filter((f) => f.kind === "image")
          .map(stagedImageEntry),
      );
      setStep(2);
      toast.success("Model imported — review and save");
      for (const warning of draft.warnings ?? []) {
        toast.warning(warning);
      }
    } catch {
      // corrupt draft — start with an empty form
    }
  }, [model]);

  // New images render from object URLs; revoke them when the form unmounts.
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(
    () => () => {
      for (const image of imagesRef.current) {
        if (image.type === "new") URL.revokeObjectURL(image.src);
      }
    },
    [],
  );

  function addImages(files: File[]) {
    setImages((prev) => [...prev, ...files.map(newImageEntry)]);
  }

  function removeImage(key: string) {
    setImages((prev) => {
      const entry = prev.find((image) => image.key === key);
      if (entry?.type === "new") URL.revokeObjectURL(entry.src);
      return prev.filter((image) => image.key !== key);
    });
  }

  function moveImage(key: string, direction: -1 | 1) {
    setImages((prev) => {
      const i = prev.findIndex((image) => image.key === key);
      const j = i + direction;
      if (i === -1 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  // Moves the dragged image to the position of the tile it is dragged over.
  function reorderImage(key: string, targetKey: string) {
    setImages((prev) => {
      const from = prev.findIndex((image) => image.key === key);
      const to = prev.findIndex((image) => image.key === targetKey);
      if (from === -1 || to === -1 || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

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
          setImages((prev) => {
            const known = new Set(
              prev
                .filter((image) => image.type === "new")
                .map((image) => `${image.filename}:${image.size}`),
            );
            const fresh = meta.images.filter((f) => !known.has(`${f.name}:${f.size}`));
            return [...prev, ...fresh.map(newImageEntry)];
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

  function goToStep(target: 1 | 2) {
    if (target === step) return;
    if (target === 2 && (!hasModelFile || extracting > 0)) return;
    setPreview(false);
    setStep(target);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!hasModelFile) {
      toast.error("Add at least one .3mf file");
      setPreview(false);
      setStep(1);
      return;
    }
    // The title input is unmounted while previewing, so native `required`
    // can't catch this there.
    if (!title.trim()) {
      toast.error("Title is required");
      setPreview(false);
      return;
    }

    try {
      // Images upload in display order so their positions (and the cover)
      // match what the user arranged.
      const newImages = images.filter((image) => image.type === "new");
      const toUpload: {
        file: File;
        kind: "model" | "image" | "pdf";
        filename: string;
      }[] = [
        ...modelFiles.map((f) => ({ file: f.file, kind: "model" as const, filename: f.name })),
        ...pdfFiles.map((f) => ({ file: f.file, kind: "pdf" as const, filename: f.name })),
        ...newImages.map((image) => ({
          file: image.file,
          kind: "image" as const,
          filename: image.file.name,
        })),
      ];
      const uploaded: UploadedFile[] = [];
      for (const [i, { file, kind, filename }] of toUpload.entries()) {
        setStatus(`Uploading ${i + 1}/${toUpload.length}: ${filename}`);
        uploaded.push(await uploadFile(file, kind, filename));
      }

      // On success the action redirects (handled by Next); it only returns
      // a value when something went wrong.
      let result: { error: string } | undefined;
      if (model) {
        setStatus("Saving changes…");
        const keptIds = new Set([
          ...existingModelFiles.map((f) => f.id),
          ...existingPdfFiles.map((f) => f.id),
          ...images
            .filter((image) => image.type === "existing")
            .map((image) => image.id),
        ]);
        let uploadIndex = modelFiles.length + pdfFiles.length;
        const imageOrder: ImageOrderRef[] = images.map((image) =>
          image.type === "existing"
            ? { existingId: image.id }
            : { newIndex: uploadIndex++ },
        );
        result = await updateModel({
          modelId: model.id,
          title,
          description,
          categoryId: categoryId || null,
          tags: tags.split(","),
          newFiles: uploaded,
          removedFileIds: model.files
            .filter((f) => !keptIds.has(f.id))
            .map((f) => f.id),
          renamedFiles: existingModelFiles.map((f) => ({
            id: f.id,
            filename: f.filename,
          })),
          imageOrder,
          bom,
        });
      } else {
        setStatus("Creating model…");
        // Order determines position (and the cover = first image): staged
        // model files, freshly uploaded models, PDFs, then images as arranged
        // in the wizard (staged and new interleaved).
        const uploadedImages = uploaded.filter((f) => f.kind === "image");
        const uploadedModels = uploaded.filter((f) => f.kind === "model");
        const uploadedPdfs = uploaded.filter((f) => f.kind === "pdf");
        // uploadedImages holds the new images in `images` order, so walking
        // `images` and consuming them one by one restores the arrangement.
        let uploadedIndex = 0;
        const orderedImages: UploadedFile[] = [];
        for (const image of images) {
          if (image.type === "staged") orderedImages.push(image.staged);
          else if (image.type === "new")
            orderedImages.push(uploadedImages[uploadedIndex++]);
        }
        result = await createModel({
          title,
          description,
          categoryId: categoryId || null,
          tags: tags.split(","),
          files: [
            ...stagedModelFiles,
            ...uploadedModels,
            ...uploadedPdfs,
            ...orderedImages,
          ],
          bom,
          sourceUrl,
          onshapeMicroversion,
        });
      }
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

  // Content is capped at max-w-2xl (42rem) for readability, so the sidebar
  // column sits snugly against it — except in preview mode, where
  // ModelPreview wants the full column width to mimic the real model page.
  const wide = step === 2 && preview;

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        "grid gap-6 lg:items-start lg:gap-10",
        wide ? "lg:grid-cols-[1fr_280px]" : "lg:grid-cols-[42rem_280px]",
      )}
    >
      <div className="min-w-0 grid gap-6">
        <div className="grid gap-6 max-w-2xl">
          <StepIndicator
            step={step}
            canGoToDetails={hasModelFile && extracting === 0}
            onSelect={goToStep}
          />

          {step === 1 && (
            <FilePicker
              hint="Click to add .3mf files — title, description, images and printer are imported automatically"
              accept={MODEL_ACCEPT}
              files={modelFiles}
              setFiles={setModelFiles}
              existing={existingModelFiles}
              removeExisting={(id) =>
                setExistingModelFiles((files) => files.filter((f) => f.id !== id))
              }
              renameExisting={(id, name) =>
                setExistingModelFiles((files) =>
                  files.map((f) => (f.id === id ? { ...f, filename: name } : f)),
                )
              }
              staged={stagedModelFiles}
              removeStaged={(key) =>
                setStagedModelFiles((prev) => prev.filter((f) => f.key !== key))
              }
              renameStaged={(key, name) =>
                setStagedModelFiles((prev) =>
                  prev.map((f) => (f.key === key ? { ...f, filename: name } : f)),
                )
              }
              onFilesAdded={importFrom3mf}
              onRenameNew={(key, name) =>
                setModelFiles((files) =>
                  files.map((f) => (f.key === key ? { ...f, name } : f)),
                )
              }
              icon={<FileBox className="size-6" />}
            />
          )}

          {step === 2 && !preview && (
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
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="description">Description</Label>
                  <span className="text-xs text-muted-foreground">
                    Markdown supported
                  </span>
                </div>
                <Textarea
                  id="description"
                  name="description"
                  rows={6}
                  placeholder="What is it, how to print it, material recommendations… Markdown works: **bold**, - lists, [links](https://…)"
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
                label="Documents (optional)"
                hint="Click to add PDFs — build instructions, product manual, …"
                accept={PDF_ACCEPT}
                files={pdfFiles}
                setFiles={setPdfFiles}
                existing={existingPdfFiles}
                removeExisting={(id) =>
                  setExistingPdfFiles((files) => files.filter((f) => f.id !== id))
                }
                icon={<FileText className="size-6" />}
              />

              <ImagePicker
                images={images}
                onAdd={addImages}
                onRemove={removeImage}
                onMove={moveImage}
                onReorder={reorderImage}
              />

              {sourceUrl && (
                <p className="text-sm text-muted-foreground">
                  Will be linked to its source:{" "}
                  <span className="break-all">{sourceUrl}</span>
                </p>
              )}
            </>
          )}
        </div>

        {step === 2 && preview && (
          <ModelPreview
            data={{
              title,
              description,
              categoryName:
                categories.find((c) => c.id === categoryId)?.name ?? null,
              tags: [
                ...new Set(
                  tags
                    .split(",")
                    .map((t) => t.trim().toLowerCase())
                    .filter(Boolean),
                ),
              ],
              bom,
              images: images.map((image) => ({ src: image.src })),
              printFiles: [
                ...existingModelFiles.map((f) => ({
                  filename: f.filename,
                  size: f.size,
                })),
                ...stagedModelFiles.map((f) => ({
                  filename: f.filename,
                  size: f.size,
                })),
                ...modelFiles.map((f) => ({ filename: f.name, size: f.file.size })),
              ],
              pdfFiles: [
                ...existingPdfFiles.map((f) => ({
                  filename: f.filename,
                  size: f.size,
                })),
                ...pdfFiles.map((f) => ({ filename: f.name, size: f.file.size })),
              ],
              userName,
              createdAt: model?.createdAt ?? new Date(),
            }}
          />
        )}
      </div>

      <Card size="sm" className="lg:sticky lg:top-20">
        <CardContent className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            className="col-span-2 w-full"
            disabled={status !== null || step === 1}
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? (
              <>
                <Pencil className="size-4" />
                Back to editing
              </>
            ) : (
              <>
                <Eye className="size-4" />
                Preview
              </>
            )}
          </Button>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={status !== null || step === 1}
            onClick={() => {
              setPreview(false);
              setStep(1);
            }}
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={
              status !== null || step === 2 || !hasModelFile || extracting > 0
            }
            onClick={() => {
              setPreview(false);
              setStep(2);
            }}
          >
            {extracting > 0 ? "Reading…" : "Next"}
            <ArrowRight className="size-4" />
          </Button>

          <Separator className="col-span-2 my-1" />

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={status !== null}
              >
                Cancel
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard changes?</AlertDialogTitle>
                <AlertDialogDescription>
                  {model
                    ? "Your changes to this model will be lost."
                    : "This model won't be created."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep editing</AlertDialogCancel>
                <AlertDialogAction onClick={() => router.push(cancelHref)}>
                  Discard
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Button type="submit" className="w-full" disabled={status !== null}>
            {status ?? (model ? "Save changes" : "Create model")}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
