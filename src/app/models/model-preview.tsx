"use client";

import { Eye } from "lucide-react";
import type { BomItemInput } from "@/lib/bom";
import { ModelView, type ModelViewData } from "./model-view";

export type ModelPreviewData = {
  title: string;
  description: string;
  categoryName: string | null;
  tags: string[];
  bom: BomItemInput[];
  images: { src: string }[];
  printFiles: { filename: string; size: number }[];
  pdfFiles: { filename: string; size: number }[];
  userName: string;
  createdAt: Date;
};

export function ModelPreview({ data }: { data: ModelPreviewData }) {
  const viewData: ModelViewData = {
    title: data.title,
    description: data.description,
    author: data.userName,
    createdAt: data.createdAt,
    category: data.categoryName ? { name: data.categoryName } : null,
    tags: data.tags.map((name) => ({ name })),
    platform: null,
    parametric: data.printFiles.some((f) =>
      f.filename.toLowerCase().endsWith(".scad"),
    ),
    sourceUrl: null,
    sourceName: null,
    onshapeWvm: null,
    makerworldUrl: null,
    images: data.images,
    // Files aren't stored yet in the create wizard, so there's nothing to load.
    modelFiles: [],
    bom: data.bom.filter((item) => item.name.trim()),
    printFiles: data.printFiles.map((f) => ({
      id: null,
      downloadToken: null,
      filename: f.filename,
      size: f.size,
      printTime: null,
      grams: null,
      approx: false,
      plateCount: null,
      printer: null,
      sliceStatus: null,
      sliceError: null,
    })),
    pdfFiles: data.pdfFiles.map((f) => ({
      id: null,
      filename: f.filename,
      size: f.size,
    })),
    modelId: null,
    canManage: false,
    isLoggedIn: false,
    collectionOptions: [],
    slicerConfigured: false,
  };

  return (
    <div className="rounded-lg border border-dashed">
      <div className="flex items-center gap-2 border-b border-dashed px-4 py-2 text-xs text-muted-foreground">
        <Eye className="size-3.5" />
        Preview — this is how the model page will look
      </div>
      <div className="p-4 sm:p-6">
        <ModelView data={viewData} />
      </div>
    </div>
  );
}
