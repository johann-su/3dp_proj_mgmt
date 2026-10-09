import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import { getSession } from "@/lib/auth";
import { resolveShareLink, shareGrantsModel } from "@/lib/share-links";
import { sharePagePath } from "@/lib/share-token";
import { ModelView } from "@/app/models/model-view";
import { ShareBanner } from "../../share-banner";
import { loadSharedModelView } from "../../shared-model";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared on Print Vault",
  robots: { index: false, follow: false },
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A model opened from a shared collection. Access is the link's, checked per
// request: the model must still be a (non-trashed) member, so taking it out
// of the collection unshares it here too.
export default async function SharedCollectionModelPage({
  params,
}: {
  params: Promise<{ token: string; modelId: string }>;
}) {
  const { token, modelId } = await params;
  if (!UUID_RE.test(modelId)) notFound();

  const [share, session] = await Promise.all([resolveShareLink(token), getSession()]);
  if (!share) notFound();
  // A model link has exactly one page; send it there.
  if (share.kind === "model") {
    if (share.modelId === modelId) redirect(sharePagePath(share.token));
    notFound();
  }
  if (!(await shareGrantsModel(share, modelId))) notFound();

  const data = await loadSharedModelView(share.token, modelId);
  if (!data) notFound();

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <ShareBanner signedIn={!!session} catalogHref={`/models/${modelId}`} />
      <Link
        href={sharePagePath(share.token)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to collection
      </Link>
      <ModelView data={data} />
    </div>
  );
}
