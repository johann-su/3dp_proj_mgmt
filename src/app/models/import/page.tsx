import { redirect } from "next/navigation";
import { getSession, signInRedirect } from "@/lib/auth";
import { ImportForm } from "./import-form";

export const dynamic = "force-dynamic";

export default async function ImportModelPage() {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-2">Import from URL</h1>
      <p className="text-muted-foreground text-sm mb-6">
        Paste a MakerWorld or Printables model link. The model info, images and
        files are fetched and prefilled into the create form.
      </p>
      <ImportForm />
    </div>
  );
}
