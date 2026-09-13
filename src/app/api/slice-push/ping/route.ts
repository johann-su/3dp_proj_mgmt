// Slice-push ping (issue #122): does this URL + token actually work?
//
// The plugin's setup step calls this before it stores anything, so a typo in
// the instance URL or a revoked token is reported while the user is still
// looking at the settings page — rather than silently, after a 40-minute slice.
// Answers with the instance's own idea of its public origin, which is what the
// plugin then uses to build push URLs.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { authenticatePush } from "@/lib/push-tokens";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await authenticatePush(req.headers.get("authorization"));
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const account = await db.query.user.findFirst({
    where: eq(user.id, auth.userId),
    columns: { name: true, email: true },
  });
  return NextResponse.json({
    ok: true,
    origin: appUrl("/").toString().replace(/\/$/, ""),
    user: account?.name ?? account?.email ?? null,
  });
}
