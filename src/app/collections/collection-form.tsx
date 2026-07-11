"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { createCollection, updateCollection } from "@/app/collections/actions";
import type { RuleGroup } from "@/lib/collection-rules";
import { isNextRedirectError } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RuleBuilder, emptyRuleGroup, type RuleBuilderFacets } from "./rule-builder";

// Shared create/edit collection form. Passing a collectionId switches it to
// edit mode (updateCollection); both actions redirect to the collection on
// success. The smart-collection toggle reveals the rule builder (issue #46);
// it's hidden for MakerWorld-imported collections, whose membership is owned
// by "Sync from MakerWorld".
export function CollectionForm({
  collectionId,
  initialTitle = "",
  initialDescription = "",
  initialSmart = false,
  initialRules = null,
  allowSmart,
  facets,
}: {
  collectionId?: string;
  initialTitle?: string;
  initialDescription?: string;
  initialSmart?: boolean;
  initialRules?: RuleGroup | null;
  allowSmart: boolean;
  facets: RuleBuilderFacets;
}) {
  const [saving, setSaving] = useState(false);
  const [smart, setSmart] = useState(initialSmart);
  const [rules, setRules] = useState<RuleGroup>(initialRules ?? emptyRuleGroup());

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const input = {
      title: String(form.get("title")),
      description: String(form.get("description")),
      smart,
      rules: smart ? rules : undefined,
    };
    setSaving(true);
    try {
      // Redirects to the collection on success.
      const result = collectionId
        ? await updateCollection({ collectionId, ...input })
        : await createCollection(input);
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
        <Input
          id="title"
          name="title"
          required
          defaultValue={initialTitle}
          placeholder="e.g. Printer upgrades"
        />
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

      {allowSmart && (
        <div className="grid gap-3 rounded-lg border p-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={smart}
              onChange={(e) => setSmart(e.target.checked)}
              className="mt-1 size-4 accent-primary"
            />
            <span className="grid gap-0.5">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles className="size-4" />
                Smart collection
              </span>
              <span className="text-sm text-muted-foreground">
                Models are included automatically when they match the rules
                below — no manual adding, and membership stays up to date.
              </span>
            </span>
          </label>
          {smart && <RuleBuilder value={rules} onChange={setRules} facets={facets} />}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={saving}>
          {saving
            ? "Saving…"
            : collectionId
              ? "Save changes"
              : "Create collection"}
        </Button>
        {collectionId && (
          <Button asChild variant="ghost" disabled={saving}>
            <Link href={`/collections/${collectionId}`}>Cancel</Link>
          </Button>
        )}
      </div>
    </form>
  );
}
