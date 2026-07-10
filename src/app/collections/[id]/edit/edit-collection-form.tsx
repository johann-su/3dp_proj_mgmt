"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { updateCollection } from "@/app/collections/actions";
import { isNextRedirectError } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function EditCollectionForm({
  collectionId,
  initialTitle,
  initialDescription,
}: {
  collectionId: string;
  initialTitle: string;
  initialDescription: string;
}) {
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    try {
      // Redirects back to the collection on success.
      const result = await updateCollection({
        collectionId,
        title: String(form.get("title")),
        description: String(form.get("description")),
      });
      if (result?.error) {
        setSaving(false);
        toast.error(result.error);
      }
    } catch (err) {
      if (isNextRedirectError(err)) return;
      setSaving(false);
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-6">
      <div className="grid gap-2">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required defaultValue={initialTitle} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="description">Description (optional)</Label>
        <Textarea
          id="description"
          name="description"
          rows={4}
          defaultValue={initialDescription}
          placeholder="What belongs in this collection?"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        <Button asChild variant="ghost" disabled={saving}>
          <Link href={`/collections/${collectionId}`}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
