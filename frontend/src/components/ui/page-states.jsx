/**
 * Shared loading skeletons and empty states for the console pages.
 *
 * A loading surface keeps the shape of the data it is about to show —
 * stat tiles stay tiles, tables stay rows — so the page does not jump when
 * the response lands. An empty state says what is missing and what action
 * fills it, instead of rendering a bare zero.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { Inbox } from "lucide-react";

/** A grid of stat-tile placeholders. */
export function StatGridSkeleton({ count = 4, testid = "stat-grid-skeleton" }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" data-testid={testid} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="cyber-card p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-none" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-2.5 w-20 rounded-none" />
              <Skeleton className="h-5 w-12 rounded-none" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A stack of row placeholders standing in for a table or feed. */
export function RowsSkeleton({ rows = 6, testid = "rows-skeleton" }) {
  return (
    <div className="cyber-card p-4 space-y-3" data-testid={testid} aria-hidden="true">
      <Skeleton className="h-3 w-40 rounded-none" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-2 w-2 rounded-none" />
          <Skeleton className="h-3 flex-1 rounded-none" />
          <Skeleton className="h-3 w-16 rounded-none" />
        </div>
      ))}
    </div>
  );
}

/** Full-page loading composition: stats on top, rows underneath. */
export function PageSkeleton({ testid = "page-skeleton" }) {
  return (
    <div className="space-y-6" data-testid={testid} role="status" aria-label="Loading">
      <StatGridSkeleton />
      <RowsSkeleton />
    </div>
  );
}

/** Empty state with a reason and (optionally) the action that fills it. */
export function EmptyState({ title, body, action, icon: Icon = Inbox, testid = "empty-state" }) {
  return (
    <div className="text-center py-10 px-6" data-testid={testid}>
      <Icon size={20} strokeWidth={1.5} className="mx-auto text-avaira-dim" aria-hidden="true" />
      <p className="font-mono text-xs text-avaira-muted uppercase tracking-widest mt-3">{title}</p>
      {body ? <p className="font-mono text-[11px] text-avaira-dim mt-2 max-w-sm mx-auto">{body}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
