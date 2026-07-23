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
  ImageIcon,
  Pencil,
  X,
} from "lucide-react";
import type { UploadedFile } from "@/app/models/actions";
import type { PrinterInfo } from "@/db/schema";
import { ModelFileEditDialog } from "./model-file-edit-dialog";
import {
  IMAGE_ACCEPT,
  MODEL_ACCEPT,
  splitExtension,
  type ExistingFile,
  type ImageEntry,
  type ModelFileEntry,
  type PendingFile,
  pendingFile,
} from "./model-form-state";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  onDragStart,
  onDragEnd,
  onDragEnter,
  onMove,
  onRemove,
  onEdit,
}: {
  entry: ModelFileEntry;
  isFirst: boolean;
  isLast: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragEnter: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  // Opens the edit dialog (rename + printer info where applicable) —
  // ModelFilePicker hosts it.
  onEdit: () => void;
}) {
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
          selecting the row's text. The up/down buttons below cover reordering
          for keyboard/touch use, where dragging is impractical. */}
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
      <span className="truncate">{entry.filename}</span>
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            aria-label={`Edit ${entry.filename}`}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Edit file</TooltipContent>
      </Tooltip>
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
  onAdd,
  onRemove,
  onRename,
  onMove,
  onReorder,
  printerEditModelId,
  onPrinterInfoSaved,
}: {
  entries: ModelFileEntry[];
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
  onRename: (key: string, name: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  onReorder: (key: string, targetKey: string) => void;
  // Enables the edit dialog's printer section (issue #79) on stored .3mf
  // rows. Unset in create mode, where there are no file rows to save against
  // yet — renaming still works there via the same dialog.
  printerEditModelId?: string;
  onPrinterInfoSaved?: (key: string, info: PrinterInfo, size: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);

  const editEntry = entries.find((entry) => entry.key === editKey);

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
              onMove={(direction) => onMove(entry.key, direction)}
              onRemove={() => onRemove(entry.key)}
              onEdit={() => setEditKey(entry.key)}
            />
          ))}
        </ul>
      )}
      {editEntry && (
        <ModelFileEditDialog
          key={editEntry.key}
          filename={editEntry.filename}
          printer={
            printerEditModelId &&
              editEntry.type === "existing" &&
              editEntry.filename.toLowerCase().endsWith(".3mf")
              ? {
                modelId: printerEditModelId,
                fileId: editEntry.id,
                current: editEntry.printerInfo,
              }
              : undefined
          }
          onClose={() => setEditKey(null)}
          onRename={(name) => onRename(editEntry.key, name)}
          onPrinterSaved={(info, size) =>
            onPrinterInfoSaved?.(editEntry.key, info, size)
          }
        />
      )}
    </div>
  );
}

export function ImagePicker({
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
