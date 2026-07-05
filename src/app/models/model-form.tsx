"use client";

import { useEffect, useRef, useState } from "react";
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

// One image in the wizard, in display order: either already stored on the
// model (edit mode) or freshly picked (src is an object URL then).
type ImageEntry = {
  key: string;
  src: string;
  filename: string;
  size: number;
} & ({ type: "existing"; id: string } | { type: "new"; file: File });

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

const MODEL_ACCEPT = ".3mf";
const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";
const PDF_ACCEPT = ".pdf";

async function uploadFile(
  file: File,
  kind: "model" | "image" | "pdf",
): Promise<UploadedFile> {
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

function FileRow({
  name,
  size,
  onRemove,
}: {
  name: string;
  size: number;
  onRemove: () => void;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm border rounded-md px-3 py-2">
      <span className="truncate">{name}</span>
      <span className="text-muted-foreground ml-auto shrink-0">
        {formatBytes(size)}
      </span>
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

// Files pulled in by URL import — already staged in S3, shown read-only-ish
// with a remove control (there is no local File to preview).
function StagedFileList({
  files,
  onRemove,
}: {
  files: UploadedFile[];
  onRemove: (key: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="grid gap-1">
      {files.map((file) => (
        <li
          key={file.key}
          className="flex min-w-0 items-center gap-2 text-sm border rounded-md px-3 py-2"
        >
          <CloudDownload className="size-3.5 text-primary shrink-0" />
          <span className="truncate">{file.filename}</span>
          <span className="text-muted-foreground ml-auto shrink-0">
            {formatBytes(file.size)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            aria-label={`Remove ${file.filename}`}
            onClick={() => onRemove(file.key)}
          >
            <X className="size-3.5" />
          </Button>
        </li>
      ))}
    </ul>
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
  onFilesAdded,
  icon,
}: {
  label?: string;
  hint: string;
  accept: string;
  files: File[];
  setFiles: (files: File[]) => void;
  existing?: ExistingFile[];
  removeExisting?: (id: string) => void;
  onFilesAdded?: (added: File[]) => void;
  icon: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasFiles = files.length > 0 || (existing?.length ?? 0) > 0;

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
      {hasFiles && (
        <ul className="grid gap-1">
          {existing?.map((file) => (
            <FileRow
              key={file.id}
              name={file.filename}
              size={file.size}
              onRemove={() => removeExisting?.(file.id)}
            />
          ))}
          {files.map((file, i) => (
            <FileRow
              key={`${file.name}-${i}`}
              name={file.name}
              size={file.size}
              onRemove={() => setFiles(files.filter((_, j) => j !== i))}
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

export function ModelForm({
  categories,
  userName,
  model,
}: {
  categories: Category[];
  userName: string;
  model?: ModelFormInitial;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [preview, setPreview] = useState(false);
  const [title, setTitle] = useState(model?.title ?? "");
  const [description, setDescription] = useState(model?.description ?? "");
  const [tags, setTags] = useState(model?.tags.join(", ") ?? "");
  const [existingModelFiles, setExistingModelFiles] = useState<ExistingFile[]>(
    () => model?.files.filter((f) => f.kind === "model") ?? [],
  );
  const [modelFiles, setModelFiles] = useState<File[]>([]);
  const [existingPdfFiles, setExistingPdfFiles] = useState<ExistingFile[]>(
    () => model?.files.filter((f) => f.kind === "pdf") ?? [],
  );
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
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

  // Files pulled in by URL import (already staged in S3) and the source link,
  // only used when creating a new model.
  const [stagedModelFiles, setStagedModelFiles] = useState<UploadedFile[]>([]);
  const [stagedImageFiles, setStagedImageFiles] = useState<UploadedFile[]>([]);
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
      setStagedImageFiles((draft.files ?? []).filter((f) => f.kind === "image"));
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
      const toUpload: { file: File; kind: "model" | "image" | "pdf" }[] = [
        ...modelFiles.map((file) => ({ file, kind: "model" as const })),
        ...pdfFiles.map((file) => ({ file, kind: "pdf" as const })),
        ...newImages.map((image) => ({ file: image.file, kind: "image" as const })),
      ];
      const uploaded: UploadedFile[] = [];
      for (const [i, { file, kind }] of toUpload.entries()) {
        setStatus(`Uploading ${i + 1}/${toUpload.length}: ${file.name}`);
        uploaded.push(await uploadFile(file, kind));
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
          imageOrder,
          bom,
        });
      } else {
        setStatus("Creating model…");
        // Order determines position (and the cover = first image): staged
        // model files, freshly uploaded models, PDFs, staged images, new images.
        const uploadedImages = uploaded.filter((f) => f.kind === "image");
        const uploadedModels = uploaded.filter((f) => f.kind === "model");
        const uploadedPdfs = uploaded.filter((f) => f.kind === "pdf");
        result = await createModel({
          title,
          description,
          categoryId: categoryId || null,
          tags: tags.split(","),
          files: [
            ...stagedModelFiles,
            ...uploadedModels,
            ...uploadedPdfs,
            ...stagedImageFiles,
            ...uploadedImages,
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

  return (
    <form onSubmit={handleSubmit} className="grid gap-6">
      <div className="mx-auto w-full max-w-2xl grid gap-6">
        <StepIndicator step={step} />

        {step === 1 && (
          <>
            <FilePicker
              hint="Click to add .3mf files — title, description, images and printer are imported automatically"
              accept={MODEL_ACCEPT}
              files={modelFiles}
              setFiles={setModelFiles}
              existing={existingModelFiles}
              removeExisting={(id) =>
                setExistingModelFiles((files) => files.filter((f) => f.id !== id))
              }
              onFilesAdded={importFrom3mf}
              icon={<FileBox className="size-6" />}
            />
            <StagedFileList
              files={stagedModelFiles}
              onRemove={(key) =>
                setStagedModelFiles((prev) => prev.filter((f) => f.key !== key))
              }
            />
            <Button
              type="button"
              className="justify-self-end"
              disabled={!hasModelFile || extracting > 0}
              onClick={() => setStep(2)}
            >
              {extracting > 0 ? "Reading metadata…" : "Continue"}
              <ArrowRight className="size-4" />
            </Button>
          </>
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

            {stagedModelFiles.length > 0 && (
              <div className="grid gap-2">
                <Label>Imported model files</Label>
                <StagedFileList
                  files={stagedModelFiles}
                  onRemove={(key) =>
                    setStagedModelFiles((prev) =>
                      prev.filter((f) => f.key !== key),
                    )
                  }
                />
              </div>
            )}

            <ImagePicker
              images={images}
              onAdd={addImages}
              onRemove={removeImage}
              onMove={moveImage}
              onReorder={reorderImage}
            />

            {stagedImageFiles.length > 0 && (
              <div className="grid gap-2">
                <Label>Imported images</Label>
                <StagedFileList
                  files={stagedImageFiles}
                  onRemove={(key) =>
                    setStagedImageFiles((prev) =>
                      prev.filter((f) => f.key !== key),
                    )
                  }
                />
              </div>
            )}

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
              ...modelFiles.map((f) => ({ filename: f.name, size: f.size })),
            ],
            pdfFiles: [
              ...existingPdfFiles.map((f) => ({
                filename: f.filename,
                size: f.size,
              })),
              ...pdfFiles.map((f) => ({ filename: f.name, size: f.size })),
            ],
            userName,
            createdAt: model?.createdAt ?? new Date(),
          }}
        />
      )}

      {step === 2 && (
        <div className="mx-auto w-full max-w-2xl flex justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={status !== null}
            onClick={() => {
              setPreview(false);
              setStep(1);
            }}
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={status !== null}
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
            <Button type="submit" disabled={status !== null}>
              {status ?? (model ? "Save changes" : "Create model")}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
