// Bill of materials helpers shared by the wizard (CSV upload), the create
// action (validation) and the CSV download route.

export type BomItemInput = {
  name: string;
  quantity: string;
  link: string | null;
  imageUrl: string | null;
};

export const MAX_BOM_ITEMS = 200;

export const BOM_CSV_HEADER = ["name", "quantity", "link", "image"] as const;

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// Returns the cleaned list, or an error string.
export function sanitizeBomItems(
  items: BomItemInput[],
): { items: BomItemInput[] } | { error: string } {
  if (items.length > MAX_BOM_ITEMS) {
    return { error: `A BOM can have at most ${MAX_BOM_ITEMS} items` };
  }
  const cleaned: BomItemInput[] = [];
  for (const item of items) {
    const name = item.name.trim();
    if (!name) continue; // skip blank rows instead of failing
    const link = item.link?.trim() || null;
    const imageUrl = item.imageUrl?.trim() || null;
    if (link && !isHttpUrl(link)) {
      return { error: `BOM item "${name}": link must be a http(s) URL` };
    }
    if (imageUrl && !isHttpUrl(imageUrl)) {
      return { error: `BOM item "${name}": image must be a http(s) URL` };
    }
    cleaned.push({
      name: name.slice(0, 200),
      quantity: (item.quantity.trim() || "1").slice(0, 50),
      link,
      imageUrl,
    });
  }
  return { items: cleaned };
}

// Minimal RFC 4180 CSV parser (quotes, escaped quotes, newlines in fields).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const HEADER_ALIASES: Record<string, keyof BomItemInput> = {
  name: "name",
  item: "name",
  part: "name",
  quantity: "quantity",
  qty: "quantity",
  amount: "quantity",
  count: "quantity",
  link: "link",
  url: "link",
  image: "imageUrl",
  image_url: "imageUrl",
  imageurl: "imageUrl",
  picture: "imageUrl",
};

// Parses BOM CSV content. The first row may be a header (name/item, qty/…);
// without one, columns are taken as name,quantity,link,image.
export function parseBomCsv(text: string): { items: BomItemInput[] } | { error: string } {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length === 0) return { error: "The CSV file is empty" };

  let columns: (keyof BomItemInput | null)[] = ["name", "quantity", "link", "imageUrl"];
  let dataRows = rows;

  const headerCells = rows[0].map((cell) => cell.trim().toLowerCase());
  const mapped = headerCells.map((cell) => HEADER_ALIASES[cell] ?? null);
  if (mapped.some((column) => column !== null)) {
    columns = mapped;
    dataRows = rows.slice(1);
  }

  const items: BomItemInput[] = dataRows.map((row) => {
    const item: BomItemInput = { name: "", quantity: "", link: null, imageUrl: null };
    row.forEach((cell, i) => {
      const column = columns[i];
      if (column) item[column] = cell.trim() as never;
    });
    return item;
  });

  const result = sanitizeBomItems(items);
  if ("error" in result) return result;
  if (result.items.length === 0) {
    return { error: "No BOM items found — expected columns: name, quantity, link, image" };
  }
  return result;
}

function csvEscape(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function bomToCsv(
  items: { name: string; quantity: string; link: string | null; imageUrl: string | null }[],
): string {
  const lines = [BOM_CSV_HEADER.join(",")];
  for (const item of items) {
    lines.push(
      [item.name, item.quantity, item.link ?? "", item.imageUrl ?? ""]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
