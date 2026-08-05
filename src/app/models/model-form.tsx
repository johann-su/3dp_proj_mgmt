"use client";

// The two-step create/edit wizard. Owns all form state and the submit flow;
// the picker components live in model-form-pickers.tsx and the entry types +
// pure order/dirty logic in model-form-state.ts.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Eye, FileText, Pencil } from "lucide-react";
import {
  createModel,
  updateModel,
  type CreateModelInput,
  type ModelSaveResult,
  type UpdateModelInput,
  type UploadedFile,
} from "@/app/models/actions";
import type { DuplicateMatch } from "@/lib/duplicates";
import { DuplicateMatchList } from "@/components/duplicate-match-list";
import { extract3mfMetadata } from "@/lib/threemf";
import { suggestCategory } from "@/lib/category-suggest";
import { OTHER_CATEGORY_SLUG } from "@/lib/category-defaults";
import type { BomItemInput } from "@/lib/bom";
import { canonicalYouTubeUrl, parseYouTubeUrl } from "@/lib/video";
import { IMPORT_DRAFT_KEY, type ImportDraftPayload } from "./import-draft";
import { BomEditor } from "./bom-editor";
import { ModelPreview } from "./model-preview";
import {
  PDF_ACCEPT,
  buildUpdateFileOrders,
  formIsDirty,
  isQueuedForSlicing,
  mediaFromInitial,
  mediaFiles,
  mediaLinkedVideos,
  mergeTags,
  newMediaFileEntry,
  newModelFileEntry,
  orderFilesForCreate,
  skippedSliceKeys,
  stagedMediaFileEntry,
  stagedModelFileEntry,
  toggleSliceQueue,
  uploadFile,
  linkedVideoEntry,
  type ExistingFile,
  type MediaEntry,
  type ModelFileEntry,
  type ModelFormInitial,
  type PendingFile,
} from "./model-form-state";
import {
  FilePicker,
  MediaPicker,
  ModelFilePicker,
  StepIndicator,
} from "./model-form-pickers";
import { cn, isNextRedirectError } from "@/lib/utils";
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
} from "@/components/ui/alert-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export type { ExistingFile, ModelFormInitial } from "./model-form-state";

type Category = { id: string; name: string; slug: string; keywords: string[] };

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
  const discardMessage = model
    ? "Your changes to this model will be lost."
    : "This model won't be created.";
  const [step, setStep] = useState<1 | 2>(1);
  const [preview, setPreview] = useState(false);
  const [title, setTitle] = useState(model?.title ?? "");
  const [description, setDescription] = useState(model?.description ?? "");
  const [tags, setTags] = useState(model?.tags.join(", ") ?? "");
  const [modelFileEntries, setModelFileEntries] = useState<ModelFileEntry[]>(
    () =>
      (model?.files ?? [])
        .filter((f) => f.kind === "model")
        .map((f) => ({
          key: f.id,
          type: "existing",
          id: f.id,
          imported: f.imported,
          filename: f.filename,
          size: f.size,
          sliceStatus: f.sliceStatus,
        })),
  );
  // Which .3mf files the save hands to the slicer, as overrides of the
  // per-entry default (new: yes, already stored: no) — see model-form-state.
  const [sliceOverrides, setSliceOverrides] = useState<Record<string, boolean>>(
    {},
  );
  const [existingPdfFiles, setExistingPdfFiles] = useState<ExistingFile[]>(
    () => model?.files.filter((f) => f.kind === "pdf") ?? [],
  );
  const [pdfFiles, setPdfFiles] = useState<PendingFile[]>([]);
  // PDFs pulled in by a URL import — already staged in S3 (create mode only).
  const [stagedPdfFiles, setStagedPdfFiles] = useState<UploadedFile[]>([]);
  // The gallery — uploaded photos/videos and linked videos in one list. That
  // list's order is the carousel's, and each linked video's index in it is
  // the position saved with it.
  const [media, setMedia] = useState<MediaEntry[]>(() =>
    mediaFromInitial(
      (model?.files ?? [])
        .filter((f) => f.kind === "image" || f.kind === "video")
        .map((f) => ({
          key: f.id,
          type: "existing" as const,
          id: f.id,
          src: `/api/files/${f.id}`,
          filename: f.filename,
          size: f.size,
          kind: f.kind === "video" ? ("video" as const) : ("image" as const),
        })),
      model?.videos ?? [],
    ),
  );
  const [categoryId, setCategoryId] = useState<string>(model?.categoryId ?? "");
  // Until the user picks a category themselves, the select tracks a live
  // suggestion (edit mode keeps the stored choice untouched).
  const [categoryTouched, setCategoryTouched] = useState(!!model);
  // Source platform category names from a URL import — the strongest
  // suggestion signal (e.g. MakerWorld's "Signs & Logos" → Art).
  const [sourceCategories, setSourceCategories] = useState<string[]>([]);
  const [bom, setBom] = useState<BomItemInput[]>(model?.bom ?? []);
  const [status, setStatus] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(0);

  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [onshapeMicroversion, setOnshapeMicroversion] = useState<string | null>(null);
  // Models the URL importer flagged this draft against and the user imported
  // anyway — recorded on save so an admin can scrub the copies later.
  const [duplicateOfIds, setDuplicateOfIds] = useState<string[]>([]);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // Set when the save came back flagged: a model file here already lives on
  // another model (issue #118). Flag-only — "Save anyway" re-runs the same
  // save with confirmDuplicate.
  const [pendingDuplicates, setPendingDuplicates] = useState<
    DuplicateMatch[] | null
  >(null);
  // The save payload built by handleSubmit, kept so "Save anyway" can re-issue
  // it without re-uploading the files (they are already staged in S3).
  const pendingSaveRef = useRef<
    | { mode: "create"; input: CreateModelInput }
    | { mode: "update"; input: UpdateModelInput }
    | null
  >(null);

  const hasModelFile = modelFileEntries.length > 0;

  const dirty = formIsDirty(
    {
      title,
      description,
      categoryId,
      tags,
      bom,
      modelFileEntries,
      media,
      pdfFiles,
      existingPdfFiles,
      sliceOverrides,
    },
    model,
  );

  // The popstate listener below is installed once, so it reads `dirty` through
  // a ref to always see the current value.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Trap the browser back button behind the same discard-changes prompt as
  // the Cancel button — but only when there are unsaved changes. Push a
  // same-URL history entry so a back press is a popstate we can intercept:
  // when dirty, re-push it to neutralize the back and show the confirm dialog;
  // when clean, let the exit proceed to the cancel target.
  useEffect(() => {
    window.history.pushState(null, "", window.location.href);
    const handlePopState = () => {
      if (!dirtyRef.current) {
        router.push(cancelHref);
        return;
      }
      window.history.pushState(null, "", window.location.href);
      setShowDiscardConfirm(true);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [router, cancelHref]);

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
      setSourceCategories(draft.categories ?? []);
      setSourceUrl(draft.sourceUrl ?? null);
      setOnshapeMicroversion(draft.onshapeMicroversion ?? null);
      setDuplicateOfIds(draft.duplicateOfIds ?? []);
      setModelFileEntries(
        (draft.files ?? [])
          .filter((f) => f.kind === "model")
          .map(stagedModelFileEntry),
      );
      // Staged photos/videos and any linked videos the archive carried, woven
      // back into the one order the exporting instance showed them in.
      setMedia(
        mediaFromInitial(
          (draft.files ?? [])
            .filter((f) => f.kind === "image" || f.kind === "video")
            .map(stagedMediaFileEntry),
          draft.videos ?? [],
        ),
      );
      setStagedPdfFiles((draft.files ?? []).filter((f) => f.kind === "pdf"));
      setBom(draft.bom ?? []);
      setStep(2);
      toast.success("Model imported — review and save");
      for (const warning of draft.warnings ?? []) {
        toast.warning(warning);
      }
    } catch {
      // corrupt draft — start with an empty form
    }
  }, [model]);

  // Keep the category synced to the best suggestion (from title, tags and the
  // import source's own categories) until the user picks one; "Other" when
  // nothing matches, so no model is created without a category.
  useEffect(() => {
    if (categoryTouched) return;
    const suggested =
      suggestCategory(categories, {
        title,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        sourceCategories,
      }) ??
      categories.find((c) => c.slug === OTHER_CATEGORY_SLUG)?.id ??
      "";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCategoryId(suggested);
  }, [categoryTouched, categories, title, tags, sourceCategories]);

  // New images render from object URLs; revoke them when the form unmounts.
  const mediaRef = useRef(media);
  useEffect(() => {
    mediaRef.current = media;
  }, [media]);
  useEffect(
    () => () => {
      for (const entry of mediaRef.current) {
        if (entry.type === "new") URL.revokeObjectURL(entry.src);
      }
    },
    [],
  );

  function addImages(files: File[]) {
    setMedia((prev) => [...prev, ...files.map(newMediaFileEntry)]);
  }

  // Adds a pasted YouTube link as a gallery tile. Returns why it couldn't,
  // for the field to show — the picker owns the input, this owns the list.
  function addVideo(url: string): string | null {
    const video = parseYouTubeUrl(url);
    if (!video) {
      return "Paste a YouTube link, e.g. https://www.youtube.com/watch?v=…";
    }
    // Same video twice is a mistake; say so rather than silently dropping it
    // (the save would dedupe it away anyway).
    if (media.some((entry) => entry.key === video.id)) {
      return "That video is already in the gallery";
    }
    setMedia((prev) => [...prev, linkedVideoEntry(canonicalYouTubeUrl(video), video)]);
    return null;
  }

  function removeMedia(key: string) {
    setMedia((prev) => {
      const entry = prev.find((item) => item.key === key);
      if (entry?.type === "new") URL.revokeObjectURL(entry.src);
      return prev.filter((item) => item.key !== key);
    });
  }

  function moveMedia(key: string, direction: -1 | 1) {
    setMedia((prev) => {
      const i = prev.findIndex((item) => item.key === key);
      const j = i + direction;
      if (i === -1 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  // Moves the dragged tile to the position of the one it is dragged over.
  function reorderMedia(key: string, targetKey: string) {
    setMedia((prev) => {
      const from = prev.findIndex((item) => item.key === key);
      const to = prev.findIndex((item) => item.key === targetKey);
      if (from === -1 || to === -1 || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function removeModelFile(key: string) {
    setModelFileEntries((prev) => prev.filter((entry) => entry.key !== key));
  }

  // Queues/unqueues one .3mf for slicing. Nothing runs until the form is
  // saved — createModel/updateModel apply it (see handleSubmit).
  function toggleSlicing(entry: ModelFileEntry) {
    setSliceOverrides((prev) => toggleSliceQueue(prev, entry));
  }

  function renameModelFile(key: string, name: string) {
    setModelFileEntries((prev) =>
      prev.map((entry) => (entry.key === key ? { ...entry, filename: name } : entry)),
    );
  }

  function moveModelFile(key: string, direction: -1 | 1) {
    setModelFileEntries((prev) => {
      const i = prev.findIndex((entry) => entry.key === key);
      const j = i + direction;
      if (i === -1 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  // Moves the dragged file to the position of the row it is dragged over.
  function reorderModelFile(key: string, targetKey: string) {
    setModelFileEntries((prev) => {
      const from = prev.findIndex((entry) => entry.key === key);
      const to = prev.findIndex((entry) => entry.key === targetKey);
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
          setMedia((prev) => {
            const known = new Set(
              prev
                .filter((entry) => entry.type === "new")
                .map((entry) => `${entry.filename}:${entry.size}`),
            );
            const fresh = meta.images.filter((f) => !known.has(`${f.name}:${f.size}`));
            return [...prev, ...fresh.map(newMediaFileEntry)];
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

  function addModelFiles(files: File[]) {
    setModelFileEntries((prev) => [...prev, ...files.map(newModelFileEntry)]);
    importFrom3mf(files);
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
      toast.error("Add at least one model file (.3mf or .scad)");
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
      // Model files and gallery media upload in display order so their
      // positions (and the cover) match what the user arranged. Linked videos
      // carry no bytes — only their slot in the media list travels with the
      // save.
      const newModelFiles = modelFileEntries.filter((entry) => entry.type === "new");
      const mediaFileEntries = mediaFiles(media);
      const newMedia = mediaFileEntries.filter((entry) => entry.type === "new");
      const toUpload: {
        file: File;
        kind: "model" | "image" | "pdf" | "video";
        filename: string;
      }[] = [
        ...newModelFiles.map((entry) => ({
          file: entry.file,
          kind: "model" as const,
          filename: entry.filename,
        })),
        ...pdfFiles.map((f) => ({ file: f.file, kind: "pdf" as const, filename: f.name })),
        ...newMedia.map((entry) => ({
          file: entry.file,
          // Photo or video — the picker classified it by extension, and the
          // upload route re-checks that against the same allowlist.
          kind: entry.kind,
          filename: entry.file.name,
        })),
      ];
      const uploaded: UploadedFile[] = [];
      for (const [i, { file, kind, filename }] of toUpload.entries()) {
        setStatus(`Uploading ${i + 1}/${toUpload.length}: ${filename}`);
        uploaded.push(await uploadFile(file, kind, filename));
      }

      // Files the user took out of the slice queue, by the S3 key they were
      // stored under — everything else .3mf is sliced as usual.
      const skipSliceKeys = skippedSliceKeys(
        modelFileEntries,
        sliceOverrides,
        uploaded,
      );

      if (model) {
        setStatus("Saving changes…");
        const keptIds = new Set([
          ...modelFileEntries
            .filter((entry) => entry.type === "existing")
            .map((entry) => entry.id),
          ...existingPdfFiles.map((f) => f.id),
          ...mediaFileEntries
            .filter((entry) => entry.type === "existing")
            .map((entry) => entry.id),
        ]);
        const { modelFileOrder, mediaOrder } = buildUpdateFileOrders(
          modelFileEntries,
          pdfFiles.length,
          mediaFileEntries,
        );
        pendingSaveRef.current = {
          mode: "update",
          input: {
            modelId: model.id,
            title,
            description,
            categoryId: categoryId || null,
            tags: tags.split(","),
            newFiles: uploaded,
            removedFileIds: model.files
              .filter((f) => !keptIds.has(f.id))
              .map((f) => f.id),
            renamedFiles: modelFileEntries
              .filter((entry) => entry.type === "existing")
              .map((entry) => ({ id: entry.id, filename: entry.filename })),
            modelFileOrder,
            mediaOrder,
            bom,
            videos: mediaLinkedVideos(media),
            // Existing .3mf files the user put back in the queue — re-sliced to
            // refresh estimates and printer info (or retry a failure).
            resliceFileIds: modelFileEntries.flatMap((entry) =>
              entry.type === "existing" && isQueuedForSlicing(entry, sliceOverrides)
                ? [entry.id]
                : [],
            ),
            skipSliceKeys,
          },
        };
      } else {
        setStatus("Creating model…");
        pendingSaveRef.current = {
          mode: "create",
          input: {
            title,
            description,
            categoryId: categoryId || null,
            tags: tags.split(","),
            files: orderFilesForCreate(
              modelFileEntries,
              mediaFileEntries,
              stagedPdfFiles,
              uploaded,
            ),
            bom,
            videos: mediaLinkedVideos(media),
            sourceUrl,
            onshapeMicroversion,
            skipSliceKeys,
            duplicateOfIds,
          },
        };
      }
      await save(false);
    } catch (err) {
      if (isNextRedirectError(err)) return;
      setStatus(null);
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  // Issues the save built by handleSubmit. Split out so the duplicate prompt's
  // "Save anyway" can re-run it with confirmDuplicate — the files are already
  // staged in S3, so re-submitting the form from scratch would upload them all
  // over again. On success the action redirects (thrown and handled by Next);
  // it only returns a value when the save didn't happen.
  async function save(confirmDuplicate: boolean) {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    const result: ModelSaveResult | undefined =
      pending.mode === "create"
        ? await createModel({ ...pending.input, confirmDuplicate })
        : await updateModel({ ...pending.input, confirmDuplicate });
    if (result && "duplicates" in result) {
      setStatus(null);
      setPendingDuplicates(result.duplicates);
      return;
    }
    if (result?.error) {
      setStatus(null);
      toast.error(result.error);
    }
  }

  async function confirmDuplicateSave() {
    setPendingDuplicates(null);
    setStatus(model ? "Saving changes…" : "Creating model…");
    try {
      await save(true);
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
            <ModelFilePicker
              entries={modelFileEntries}
              sliceOverrides={sliceOverrides}
              onAdd={addModelFiles}
              onRemove={removeModelFile}
              onRename={renameModelFile}
              onMove={moveModelFile}
              onReorder={reorderModelFile}
              onToggleSlicing={toggleSlicing}
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
                  <Select
                    value={categoryId}
                    onValueChange={(value) => {
                      setCategoryTouched(true);
                      setCategoryId(value);
                    }}
                  >
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
                  {!categoryTouched && categoryId && (
                    <p className="text-xs text-muted-foreground">
                      Suggested from the title, tags and import source — change
                      it if it doesn&apos;t fit.
                    </p>
                  )}
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
                staged={stagedPdfFiles}
                removeStaged={(key) =>
                  setStagedPdfFiles((files) => files.filter((f) => f.key !== key))
                }
                icon={<FileText className="size-6" />}
              />

              <MediaPicker
                media={media}
                onAddImages={addImages}
                onAddVideo={addVideo}
                onRemove={removeMedia}
                onMove={moveMedia}
                onReorder={reorderMedia}
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
              media: mediaFiles(media).map((entry) => ({
                src: entry.src,
                kind: entry.kind,
              })),
              videos: mediaLinkedVideos(media),
              printFiles: modelFileEntries.map((entry) => ({
                filename: entry.filename,
                size: entry.size,
              })),
              pdfFiles: [
                ...existingPdfFiles.map((f) => ({
                  filename: f.filename,
                  size: f.size,
                })),
                ...stagedPdfFiles.map((f) => ({
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

          <Button
            type="button"
            variant="ghost"
            className="w-full"
            disabled={status !== null}
            onClick={() => {
              // Nothing changed → leave straight away, no prompt.
              if (!dirty) router.push(cancelHref);
              else setShowDiscardConfirm(true);
            }}
          >
            Cancel
          </Button>

          <AlertDialog
            open={showDiscardConfirm}
            onOpenChange={setShowDiscardConfirm}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Discard changes?</AlertDialogTitle>
                <AlertDialogDescription>{discardMessage}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep editing</AlertDialogCancel>
                <AlertDialogAction onClick={() => router.push(cancelHref)}>
                  Discard
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={pendingDuplicates !== null}
            onOpenChange={(open) => {
              if (!open) setPendingDuplicates(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>This file already exists</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDuplicates && pendingDuplicates.length > 1
                    ? "The same model file is already attached to these models."
                    : "The same model file is already attached to this model."}{" "}
                  Saving adds another copy of it to the library.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {pendingDuplicates && (
                <DuplicateMatchList matches={pendingDuplicates} />
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>Keep editing</AlertDialogCancel>
                <AlertDialogAction onClick={confirmDuplicateSave}>
                  Save anyway
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
