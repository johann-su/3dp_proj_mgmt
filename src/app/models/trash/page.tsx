import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { Trash2 } from "lucide-react";
import { db } from "@/db";
import { models } from "@/db/schema";
import { getSession, signInRedirect } from "@/lib/auth";
import { isModerator } from "@/lib/roles";
import { fileSrc } from "@/lib/file-token";
import { formatDate } from "@/lib/format";
import { sweepExpiredTrash, TRASH_RETENTION_DAYS } from "@/lib/model-versions";
import { TrashActions } from "./trash-actions";

export const dynamic = "force-dynamic";

// Whole days until the lazy sweep purges a trashed model for good.
function daysUntilPurge(deletedAt: Date): number {
  const purgeAt =
    deletedAt.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

// The owner's trash: soft-deleted models, restorable until the retention
// window runs out. Scoped like deletion itself — plain users only ever see
// their own trashed models, while moderators/admins (owner-equivalent on all
// content, issue #54) see the whole instance's trash so they can clean up
// after anyone.
export default async function TrashPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const moderator = isModerator(session.user.role);

  // Lazy purge instead of a scheduler (same pattern as the import-job
  // heartbeat check): expired models are destroyed when the trash is opened.
  await sweepExpiredTrash(moderator ? undefined : session.user.id);

  const trashed = await db.query.models.findMany({
    where: moderator
      ? isNotNull(models.deletedAt)
      : and(eq(models.userId, session.user.id), isNotNull(models.deletedAt)),
    orderBy: desc(models.deletedAt),
    with: {
      user: { columns: { name: true } },
      files: {
        where: (f, { eq: eqOp }) => eqOp(f.kind, "image"),
        orderBy: (f, { asc }) => asc(f.position),
        limit: 1,
      },
    },
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-1">Trash</h1>
        <p className="text-muted-foreground">
          Deleted models are kept for {TRASH_RETENTION_DAYS} days, then removed
          permanently.
        </p>
      </div>

      {trashed.length === 0 ? (
        <div className="text-center py-24 text-muted-foreground">
          <Trash2 className="size-10 mx-auto mb-3 opacity-50" />
          <p>Your trash is empty.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {trashed.map((model) => {
            const deletedAt = model.deletedAt!;
            const daysLeft = daysUntilPurge(deletedAt);
            const cover = model.files[0];
            return (
              <div
                key={model.id}
                className="flex items-center gap-4 rounded-lg border p-3"
              >
                {/* Whole left block opens the read-only preview, so a model
                    can be inspected before restoring or purging it. */}
                <Link
                  href={`/models/trash/${model.id}`}
                  className="flex min-w-0 flex-1 items-center gap-4 rounded-md outline-hidden hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="relative size-16 shrink-0 overflow-hidden rounded-md bg-muted">
                    {cover && (
                      <Image
                        src={fileSrc(cover.id)}
                        alt=""
                        fill
                        sizes="64px"
                        className="object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{model.title}</div>
                    <div className="text-sm text-muted-foreground">
                      {/* Moderators see everyone's trash — say whose model it is. */}
                      {moderator && <>by {model.user.name} · </>}
                      Deleted {formatDate(deletedAt)} · purged in {daysLeft} day
                      {daysLeft === 1 ? "" : "s"}
                    </div>
                  </div>
                </Link>
                <TrashActions modelId={model.id} title={model.title} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
