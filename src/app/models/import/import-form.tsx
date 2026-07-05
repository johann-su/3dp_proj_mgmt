"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CloudDownload } from "lucide-react";
import { IMPORT_DRAFT_KEY } from "@/app/models/new/new-model-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

export function ImportForm() {
  const router = useRouter();
  const [fetching, setFetching] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get("url")).trim();
    setFetching(true);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error ?? `Import failed (${res.status})`);
      }
      sessionStorage.setItem(IMPORT_DRAFT_KEY, JSON.stringify(body));
      router.push("/models/new");
    } catch (err) {
      setFetching(false);
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  }

  return (
    <Card>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="url">Model URL</Label>
            <Input
              id="url"
              name="url"
              type="url"
              required
              placeholder="https://www.printables.com/model/3161-3d-benchy"
              disabled={fetching}
            />
          </div>
          <Button type="submit" disabled={fetching} className="justify-self-start">
            <CloudDownload className="size-4" />
            {fetching ? "Fetching model… this can take a moment" : "Fetch model"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Printables: metadata, images and model files are imported.
            MakerWorld: metadata and images always import; the <code>.3mf</code>
            files import too once you{" "}
            <Link href="/settings/bambu" className="underline">
              connect your Bambu account
            </Link>
            . Otherwise download the .3mf in your browser and upload it — the
            metadata is read from the file automatically.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
