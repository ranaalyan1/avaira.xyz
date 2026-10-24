/**
 * Inline API failure banner for the console pages.
 *
 * Every console view fetched its data in a `try/catch` that only logged the
 * error. With no backend attached (or a real outage) the page then rendered its
 * empty state — "0 agents", "NO EXECUTIONS", "NO FEE DATA" — which reads as a
 * protocol with no activity rather than a console that could not reach the API.
 * This says what happened and offers the retry the pages already support.
 */
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function ConsoleError({
  message,
  onRetry,
  title = "Could not load this view",
  testid = "console-error",
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      data-testid={testid}
      className="mb-4 flex flex-col gap-3 border border-avaira-red/30 bg-avaira-red/5 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-avaira-red" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">{title}</p>
          <p className="mt-0.5 break-words font-mono text-[10px] text-avaira-muted">{message}</p>
        </div>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid={`${testid}-retry`}
          className="flex shrink-0 items-center gap-1.5 self-start border border-avaira-border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-avaira-muted transition-colors hover:border-avaira-primary hover:text-avaira-primary sm:self-auto"
        >
          <RefreshCw size={11} aria-hidden="true" /> Retry
        </button>
      ) : null}
    </div>
  );
}
