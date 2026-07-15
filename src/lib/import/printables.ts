// Printables importer — uses the same public GraphQL API the printables.com
// SPA talks to. Metadata and download links are available anonymously.

import { htmlishToMarkdown } from "@/lib/html";
import { MODEL_EXTENSIONS, fileExtension } from "@/lib/s3";
import {
  ImportError,
  IMPORT_CONFIRM_FILE_THRESHOLD,
  IMPORT_USER_AGENT,
  type ImportedProject,
} from "./types";

const GRAPHQL_URL = "https://api.printables.com/graphql/";
const MEDIA_BASE = "https://media.printables.com/";

export type PrintablesOptions = {
  // Skip the "a lot of files" confirmation and download every model file. Set
  // by the route once the user has agreed to import them all.
  confirmManyFiles?: boolean;
};

export function parsePrintablesUrl(url: URL): string | null {
  if (!/(^|\.)printables\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(/\/model\/(\d+)/);
  return match ? match[1] : null;
}

type PrintablesFile = {
  id: string;
  name: string;
  fileSize: number;
};

type PrintablesPrint = {
  name: string;
  description: string | null;
  summary: string | null;
  tags: { name: string }[];
  // Printables' own taxonomy; `path` is root-first (["3D Printers", "Test
  // Models"]).
  category: { path: { name: string }[] } | null;
  images: { filePath: string }[];
  stls: PrintablesFile[] | null;
  slas: PrintablesFile[] | null;
  otherFiles: PrintablesFile[] | null;
};

async function graphql<T>(query: string, variables: Record<string, unknown>) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": IMPORT_USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new ImportError(`Printables API responded with ${res.status}`);
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new ImportError(`Printables API error: ${json.errors[0].message}`);
  }
  if (!json.data) throw new ImportError("Printables API returned no data");
  return json.data;
}

const PRINT_QUERY = `query Print($id: ID!) {
  print(id: $id) {
    name
    description
    summary
    tags { name }
    category { path { name } }
    images { filePath }
    stls { id name fileSize }
    slas { id name fileSize }
    otherFiles { id name fileSize }
  }
}`;

const DOWNLOAD_MUTATION = `mutation GetDownloadLink($id: ID!, $printId: ID!, $fileType: DownloadFileTypeEnum!, $source: DownloadSourceEnum!) {
  getDownloadLink(id: $id, printId: $printId, fileType: $fileType, source: $source) {
    ok
    output { link }
  }
}`;

async function downloadLink(
  printId: string,
  fileId: string,
  fileType: "stl" | "sla" | "other_file",
): Promise<string | null> {
  try {
    const data = await graphql<{
      getDownloadLink: { ok: boolean; output: { link: string } | null };
    }>(DOWNLOAD_MUTATION, {
      id: fileId,
      printId,
      fileType,
      source: "model_detail",
    });
    return data.getDownloadLink.ok ? (data.getDownloadLink.output?.link ?? null) : null;
  } catch {
    return null;
  }
}

export async function importFromPrintables(
  url: URL,
  printId: string,
  options: PrintablesOptions = {},
): Promise<ImportedProject> {
  const data = await graphql<{ print: PrintablesPrint | null }>(PRINT_QUERY, {
    id: printId,
  });
  if (!data.print) throw new ImportError("Printables model not found");
  const print = data.print;

  const project: ImportedProject = {
    source: "printables",
    sourceUrl: url.toString(),
    title: print.name?.trim() ?? "",
    description: htmlishToMarkdown(print.description || print.summary || ""),
    tags: (print.tags ?? []).map((t) => t.name.trim().toLowerCase()).filter(Boolean),
    // Reversed to most-specific-first, matching MakerWorld's order.
    categories: (print.category?.path ?? [])
      .map((c) => c.name.trim())
      .filter(Boolean)
      .reverse(),
    assets: [],
    bom: [],
    warnings: [],
  };

  for (const image of print.images ?? []) {
    const filename = image.filePath.split("/").pop() ?? "image.jpg";
    project.assets.push({
      url: new URL(image.filePath, MEDIA_BASE).toString(),
      filename,
      kind: "image",
    });
  }

  const fileGroups: [PrintablesFile[] | null, "stl" | "sla" | "other_file"][] = [
    [print.stls, "stl"],
    [print.slas, "sla"],
    [print.otherFiles, "other_file"],
  ];
  const modelFiles = fileGroups.flatMap(([files, fileType]) =>
    (files ?? [])
      .filter((f) => MODEL_EXTENSIONS.includes(fileExtension(f.name)))
      .map((f) => ({ file: f, fileType })),
  );

  // Stop before resolving any download link when there are a lot of files, so
  // the user can confirm (or cancel) first.
  if (!options.confirmManyFiles && modelFiles.length >= IMPORT_CONFIRM_FILE_THRESHOLD) {
    return { ...project, needsConfirmation: true, fileCount: modelFiles.length };
  }

  let fileCount = 0;
  for (const { file, fileType } of modelFiles) {
    const link = await downloadLink(printId, file.id, fileType);
    if (!link) {
      project.warnings.push(`Could not get a download link for ${file.name}`);
      continue;
    }
    project.assets.push({ url: link, filename: file.name, kind: "model" });
    fileCount++;
  }

  if (fileCount === 0) {
    project.warnings.push(
      "No downloadable model files (.3mf / .scad / .step) found — add them manually.",
    );
  }

  return project;
}
