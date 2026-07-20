"use client";

// Header widget for background collection imports: a small progress ring in
// the top-right corner while a job runs, turning into a status dot when it
// finishes. Polls GET /api/import-jobs while a job is active; the import form
// fires IMPORT_JOB_STARTED_EVENT so polling starts without a page reload.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export const IMPORT_JOB_STARTED_EVENT = "printvault:import-job-started";

type ImportJob = {
  id: string;
  status: "running" | "done" | "failed" | "canceled";
  sourceUrl: string;
  collectionId: string | null;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  currentItem: string | null;
  error: string | null;
  warnings: string[];
  createdAt: string;
};

const POLL_MS = 3000;
// How long a finished job keeps its dot in the header before it expires.
const SHOW_FINISHED_MS = 60 * 60_000;
const DISMISSED_KEY = "printvault-dismissed-import-jobs";

function dismissedIds(): string[] {
  try {
    return JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function ProgressRing({ fraction }: { fraction: number }) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 20 20" className="size-5 -rotate-90">
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        className="stroke-muted-foreground/25"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0.02, fraction)))}
        className="stroke-primary transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}

export function ImportProgressIndicator() {
  const router = useRouter();
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : dismissedIds(),
  );
  // The collection page the user is likely looking at re-renders as models
  // land; refresh it when the running job's numbers move.
  const lastCompleted = useRef<number>(-1);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (timer) clearTimeout(timer);
      let running = false;
      try {
        const res = await fetch("/api/import-jobs");
        if (res.ok) {
          const body = (await res.json()) as { jobs: ImportJob[] };
          if (cancelled) return;
          // Finished jobs expire out of the header after a while; filtering
          // at fetch time keeps render pure.
          setJobs(
            body.jobs.filter(
              (j) =>
                j.status === "running" ||
                Date.now() - new Date(j.createdAt).getTime() < SHOW_FINISHED_MS,
            ),
          );
          const active = body.jobs.find((j) => j.status === "running");
          running = !!active;
          if (active && active.completed !== lastCompleted.current) {
            lastCompleted.current = active.completed;
            router.refresh();
          }
        }
      } catch {
        // transient network error — keep polling
        running = true;
      }
      if (!cancelled && running) timer = setTimeout(poll, POLL_MS);
    }

    poll();
    const onStarted = () => poll();
    window.addEventListener(IMPORT_JOB_STARTED_EVENT, onStarted);
    return () => {
      cancelled = true;
      window.removeEventListener(IMPORT_JOB_STARTED_EVENT, onStarted);
      if (timer) clearTimeout(timer);
    };
  }, [router]);

  const job =
    jobs.find((j) => j.status === "running") ??
    jobs.find((j) => j.status !== "running" && !dismissed.includes(j.id));
  if (!job) return null;

  const running = job.status === "running";
  const fraction = job.total > 0 ? job.completed / job.total : 0;
  const imported = job.completed - job.failed - job.skipped;

  const dismiss = () => {
    const next = [...dismissed, job.id];
    setDismissed(next);
    try {
      sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {}
  };

  const label = running
    ? `Importing collection: ${job.completed} of ${job.total}`
    : "Import finished";

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-md hover:bg-accent"
              aria-label={label}
            >
              {running ? (
                <ProgressRing fraction={fraction} />
              ) : job.status === "done" && job.failed === 0 ? (
                <CheckCircle2 className="size-5 text-green-600" />
              ) : (
                <AlertCircle className="size-5 text-amber-500" />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-80 p-3">
        <div className="grid gap-2 text-sm">
          {running ? (
            <>
              <p className="font-medium">
                Importing collection… {job.completed} / {job.total}
              </p>
              {job.currentItem && (
                <p className="truncate text-xs text-muted-foreground">
                  {job.currentItem}
                </p>
              )}
            </>
          ) : (
            <p className="font-medium">
              {job.status === "done" && `Import finished — ${imported} models`}
              {job.status === "failed" && (job.error ?? "Import failed")}
              {job.status === "canceled" && `Import canceled — ${imported} models kept`}
            </p>
          )}
          {(job.skipped > 0 || job.failed > 0) && (
            <p className="text-xs text-muted-foreground">
              {job.skipped > 0 && `${job.skipped} already imported`}
              {job.skipped > 0 && job.failed > 0 && " · "}
              {job.failed > 0 && `${job.failed} failed`}
            </p>
          )}
          {job.warnings.length > 0 && (
            <ul className="max-h-32 list-inside list-disc overflow-y-auto text-xs text-muted-foreground">
              {job.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2 pt-1">
            {job.collectionId && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/collections/${job.collectionId}`}>View collection</Link>
              </Button>
            )}
            {running ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => fetch(`/api/import-jobs/${job.id}/cancel`, { method: "POST" })}
              >
                Cancel
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={dismiss}>
                Dismiss
              </Button>
            )}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
