import { redirect } from "next/navigation";
import { getSession, signInRedirect } from "@/lib/auth";
import { ImportForm } from "./import-form";
import { IMPORT_TYPES, resolveImportType } from "./import-types";

export const dynamic = "force-dynamic";

export default async function ImportModelPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect(await signInRedirect());

  const config = IMPORT_TYPES[resolveImportType((await searchParams).type)];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-2">{config.heading}</h1>
      <p className="text-muted-foreground text-sm mb-6">{config.intro}</p>
      <ImportForm type={config.type} />
    </div>
  );
}
