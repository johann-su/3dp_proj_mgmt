import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models } from "@/db/schema";
import { bomToCsv } from "@/lib/bom";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const model = await db.query.models.findFirst({
    where: eq(models.id, id),
    columns: { title: true },
    with: { bomItems: { orderBy: (b, { asc }) => asc(b.position) } },
  });
  if (!model || model.bomItems.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const safeTitle =
    model.title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "model";

  return new Response(bomToCsv(model.bomItems), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeTitle}-bom.csv"`,
    },
  });
}
