import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

// Flags a running job as canceled; the runner checks the status between
// designs and stops. Models imported so far stay.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const [job] = await db
    .update(importJobs)
    .set({ status: "canceled", currentItem: null, updatedAt: new Date() })
    .where(
      and(
        eq(importJobs.id, id),
        eq(importJobs.userId, session.user.id),
        eq(importJobs.status, "running"),
      ),
    )
    .returning({ id: importJobs.id });

  if (!job) {
    return NextResponse.json(
      { error: "No running import with that id" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
