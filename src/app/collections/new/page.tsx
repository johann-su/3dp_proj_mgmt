"use client";

import { useState } from "react";
import { toast } from "sonner";
import { createCollection } from "@/app/collections/actions";
import { isNextRedirectError } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export default function NewCollectionPage() {
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    try {
      // Redirects to the new collection on success.
      const result = await createCollection({
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
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">New collection</h1>
      <form onSubmit={handleSubmit} className="grid gap-6">
        <div className="grid gap-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" required placeholder="e.g. Printer upgrades" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="description">Description (optional)</Label>
          <Textarea
            id="description"
            name="description"
            rows={4}
            placeholder="What belongs in this collection?"
          />
        </div>
        <Button type="submit" disabled={saving} className="justify-self-start">
          {saving ? "Creating…" : "Create collection"}
        </Button>
      </form>
    </div>
  );
}
