"use client";

// The create/edit wizard's file-picking UI: dashed-border pickers plus the
// row/tile lists they render (rename-in-place, drag + button reordering).
// All state lives in ModelForm (model-form.tsx); these components only
// receive entries and callbacks.

import { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CloudDownload,
  FileBox,
  GripVertical,
  Hourglass,
  ImageIcon,
  Pencil,
  Plus,
  RotateCw,
  SquarePlay,
  X,
} from "lucide-react";
import type { UploadedFile } from "@/app/models/actions";
import {
  MEDIA_ACCEPT,
  isQueuedForSlicing,
  isLinkedVideo,
  isVideoFile,
  mediaFiles,
  MODEL_ACCEPT,
  splitExtension,
  type ExistingFile,
  type MediaEntry,
  type ModelFileEntry,
  type PendingFile,
  pendingFile,
} from "./model-form-state";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { MAX_MODEL_VIDEOS, youTubeThumbnailUrl } from "@/lib/video";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
        <Tooltip>
          <TooltipTrigger asChild>
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
          </TooltipTrigger>
          <TooltipContent>Rename</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
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
        </TooltipTrigger>
        <TooltipContent>Remove</TooltipContent>
      </Tooltip>
    </li>
  );
}

export function FilePicker({
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
              imported={file.imported}
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

function ModelFileRow({
  entry,
  isFirst,
  isLast,
  dragging,
  queuedForSlicing,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onMove,
  onRemove,
  onRename,
  onToggleSlicing,
}: {
  entry: ModelFileEntry;
  isFirst: boolean;
  isLast: boolean;
  dragging: boolean;
  queuedForSlicing: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onRename: (newName: string) => void;
  onToggleSlicing: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftBase, setDraftBase] = useState("");
  const [base, ext] = splitExtension(entry.filename);
  const sliceable = ext.toLowerCase() === ".3mf";
  // Already being sliced from an earlier save — nothing left to queue or undo.
  const alreadyPending = entry.type === "existing" && entry.sliceStatus === "pending";

  function commit() {
    setEditing(false);
    const trimmed = draftBase.trim();
    if (trimmed && trimmed !== base) onRename(`${trimmed}${ext}`);
  }

  return (
    <li
      className={cn(
        "flex min-w-0 items-center gap-2 text-sm border rounded-md px-3 py-2",
        dragging && "opacity-50",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={onDragEnter}
      onDrop={(e) => e.preventDefault()}
    >
      {/* Only the grip starts the drag, so dragging doesn't fight with
          selecting text in the rename input. The up/down buttons below cover
          reordering for keyboard/touch use, where dragging is impractical. */}
      <span
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        aria-hidden="true"
        className="shrink-0 cursor-grab text-muted-foreground"
      >
        <GripVertical className="size-4" />
      </span>
      {(entry.type === "staged" ||
        (entry.type === "existing" && entry.imported)) && (
        <CloudDownload className="size-3.5 text-primary shrink-0" />
      )}
      {editing ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <Input
            autoFocus
            aria-label={`New name for ${entry.filename}`}
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
        <span className="truncate">{entry.filename}</span>
      )}
      <span className="text-muted-foreground ml-auto shrink-0">
        {formatBytes(entry.size)}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            aria-label={`Move ${entry.filename} up`}
            disabled={isFirst}
            onClick={() => onMove(-1)}
          >
            <ChevronUp className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Move up</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            aria-label={`Move ${entry.filename} down`}
            disabled={isLast}
            onClick={() => onMove(1)}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Move down</TooltipContent>
      </Tooltip>
      {/* Slicing is queued by the save, not by this click, so the whole edit
          stays one action — the hourglass shows what the save will hand over.
          New files start queued (an upload slices them anyway) and can be
          taken out; files already on the model start out of the queue, and
          adding them back re-slices to refresh estimates and printer info. */}
      {sliceable &&
        (alreadyPending ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="shrink-0 text-muted-foreground"
                aria-label={`${entry.filename} is queued for slicing`}
              >
                <Hourglass className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Already queued for slicing</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn("size-6 shrink-0", queuedForSlicing && "text-primary")}
                aria-pressed={queuedForSlicing}
                aria-label={
                  queuedForSlicing
                    ? `Don't slice ${entry.filename} when saving`
                    : `Slice ${entry.filename} when saving`
                }
                onClick={onToggleSlicing}
              >
                {queuedForSlicing ? (
                  <Hourglass className="size-3.5" />
                ) : (
                  <RotateCw className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {queuedForSlicing
                ? "Queued for slicing — runs when you save (click to skip)"
                : entry.type === "existing"
                  ? "Re-run slicing"
                  : "Slice this file when saving"}
            </TooltipContent>
          </Tooltip>
        ))}
      {!editing && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              aria-label={`Rename ${entry.filename}`}
              onClick={() => {
                setDraftBase(base);
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Rename</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            aria-label={`Remove ${entry.filename}`}
            onClick={onRemove}
          >
            <X className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Remove</TooltipContent>
      </Tooltip>
    </li>
  );
}

export function ModelFilePicker({
  entries,
  sliceOverrides,
  onAdd,
  onRemove,
  onRename,
  onMove,
  onReorder,
  onToggleSlicing,
}: {
  entries: ModelFileEntry[];
  // The .3mf entries whose slice queueing the user flipped from the default.
  sliceOverrides: Record<string, boolean>;
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
  onRename: (key: string, name: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onReorder: (key: string, targetKey: string) => void;
  onToggleSlicing: (entry: ModelFileEntry) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);

  return (
    <div className="grid gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={MODEL_ACCEPT}
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
        <FileBox className="size-6" />
        Click to add .3mf files (title, description, images and printer are
        imported automatically) or parametric .scad files. Drag rows to
        reorder.
      </button>
      {entries.length > 0 && (
        <ul className="grid gap-1">
          {entries.map((entry, i) => (
            <ModelFileRow
              key={entry.key}
              entry={entry}
              isFirst={i === 0}
              isLast={i === entries.length - 1}
              dragging={draggedKey === entry.key}
              onDragStart={() => setDraggedKey(entry.key)}
              onDragEnd={() => setDraggedKey(null)}
              onDragEnter={() => {
                if (draggedKey && draggedKey !== entry.key) {
                  onReorder(draggedKey, entry.key);
                }
              }}
              queuedForSlicing={isQueuedForSlicing(entry, sliceOverrides)}
              onMove={(direction) => onMove(entry.key, direction)}
              onRemove={() => onRemove(entry.key)}
              onRename={(name) => onRename(entry.key, name)}
              onToggleSlicing={() => onToggleSlicing(entry)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// The gallery: uploaded photos and videos plus linked YouTube videos in one
// grid, because the model page shows them as one carousel — anything dragged
// between two photos stays there (an uploaded file's index here is its
// `position`; a linked video's is the `position` saved with it, see
// mediaLinkedVideos). A linked video has no file behind it, so the picker
// carries two add affordances: the file input (photos *and* video files), and
// a URL field that only accepts a link src/lib/video.ts recognizes.
export function MediaPicker({
  media,
  onAddImages,
  onAddVideo,
  onRemove,
  onMove,
  onReorder,
}: {
  media: MediaEntry[];
  // Photos and video files alike — the picker sorts them out by extension.
  onAddImages: (files: File[]) => void;
  // Returns an error to show under the field, or null when the video was added.
  onAddVideo: (url: string) => string | null;
  onRemove: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onReorder: (key: string, targetKey: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [videoDraft, setVideoDraft] = useState("");
  const [videoError, setVideoError] = useState<string | null>(null);
  // Only *linked* videos count against the cap — uploaded video files are
  // model_files like any photo, bounded by the upload size limit instead.
  const videoCount = media.filter(isLinkedVideo).length;

  function addVideo() {
    const error = onAddVideo(videoDraft);
    setVideoError(error);
    if (!error) setVideoDraft("");
  }

  return (
    <div className="grid gap-2">
      <Label>Images & videos</Label>
      <input
        ref={inputRef}
        type="file"
        accept={MEDIA_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length > 0) onAddImages(picked);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="border border-dashed rounded-lg p-6 text-sm text-muted-foreground hover:bg-accent/50 transition-colors flex flex-col items-center gap-2"
      >
        <ImageIcon className="size-6" />
        Click to add photos or videos — the first one is the cover, drag
        thumbnails to reorder
      </button>
      <div className="flex gap-2">
        <Input
          id="video-url"
          type="url"
          inputMode="url"
          aria-label="YouTube video link"
          placeholder="…or paste a YouTube link: https://www.youtube.com/watch?v=…"
          value={videoDraft}
          disabled={videoCount >= MAX_MODEL_VIDEOS}
          onChange={(e) => {
            setVideoDraft(e.target.value);
            setVideoError(null);
          }}
          // The picker sits inside the wizard's form, where Enter would
          // otherwise submit the whole model.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addVideo();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          onClick={addVideo}
          disabled={videoCount >= MAX_MODEL_VIDEOS || !videoDraft.trim()}
        >
          <Plus className="size-4" />
          Add video
        </Button>
      </div>
      {(videoError || videoCount >= MAX_MODEL_VIDEOS) && (
        <p className={cn("text-xs", videoError ? "text-destructive" : "text-muted-foreground")}>
          {videoError ?? `That's the maximum of ${MAX_MODEL_VIDEOS} videos.`}
        </p>
      )}
      {media.length > 0 && (
        <ul className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {media.map((entry, i) => {
            const label = isLinkedVideo(entry) ? entry.url : entry.filename;
            return (
            <li
              key={entry.key}
              className={cn(
                "relative rounded-md border overflow-hidden bg-muted cursor-grab",
                draggedKey === entry.key && "opacity-50",
              )}
              title={
                isLinkedVideo(entry)
                  ? entry.url
                  : `${entry.filename} (${formatBytes(entry.size)})`
              }
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                setDraggedKey(entry.key);
              }}
              onDragEnd={() => setDraggedKey(null)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={() => {
                if (draggedKey && draggedKey !== entry.key) {
                  onReorder(draggedKey, entry.key);
                }
              }}
              onDrop={(e) => e.preventDefault()}
            >
              {isLinkedVideo(entry) ? (
                <>
                  {/* Remote host — next/image would need its own allowlist to
                      add nothing at this size. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={youTubeThumbnailUrl(entry.video)}
                    alt=""
                    className="aspect-square w-full object-cover"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <span className="flex h-6 w-9 items-center justify-center rounded bg-red-600">
                      <SquarePlay className="size-4 text-white" />
                    </span>
                  </span>
                </>
              ) : isVideoFile(entry) ? (
                <>
                  {/* preload="metadata" is enough for the browser to paint the
                      first frame as a poster; the tile never plays, so there
                      is no reason to fetch more of the file than that. */}
                  <video
                    src={entry.src}
                    muted
                    playsInline
                    preload="metadata"
                    className="aspect-square w-full bg-black object-cover"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                    <span className="flex h-6 w-9 items-center justify-center rounded bg-black/70">
                      <SquarePlay className="size-4 text-white" />
                    </span>
                  </span>
                </>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={entry.src}
                  alt={entry.filename}
                  className="aspect-square w-full object-cover"
                />
              )}
              {/* The cover is the first uploaded file — photo or video. A
                  linked video can't be one: browse cards show a stored file,
                  and there is nothing of a YouTube link to show there. */}
              {!isLinkedVideo(entry) && mediaFiles(media)[0]?.key === entry.key && (
                <span className="absolute top-1 left-1 rounded bg-primary text-primary-foreground text-[10px] font-medium px-1.5 py-0.5">
                  Cover
                </span>
              )}
              {entry.type === "staged" && (
                <span
                  className="absolute top-1 right-1 rounded bg-primary text-primary-foreground p-1"
                  title="Imported from source"
                >
                  <CloudDownload className="size-3" />
                </span>
              )}
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between p-1 bg-gradient-to-t from-black/60 to-transparent">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-6"
                      aria-label={`Move ${label} left`}
                      disabled={i === 0}
                      onClick={() => onMove(entry.key, -1)}
                    >
                      <ChevronLeft className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Move left</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-6"
                      aria-label={`Remove ${label}`}
                      onClick={() => onRemove(entry.key)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-6"
                      aria-label={`Move ${label} right`}
                      disabled={i === media.length - 1}
                      onClick={() => onMove(entry.key, 1)}
                    >
                      <ChevronRight className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Move right</TooltipContent>
                </Tooltip>
              </div>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function StepIndicator({
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
