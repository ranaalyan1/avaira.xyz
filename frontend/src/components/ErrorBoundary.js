import { Component } from "react";

/**
 * App-wide React error boundary.
 *
 * Without one, any render error anywhere in the tree unmounts the whole
 * app and the visitor is left staring at a white page — the worst possible
 * crash report. This boundary catches the error, keeps the shell alive,
 * and puts the actual failure on screen: message, stack top, and a reload
 * button. The message is data-testid'd so support can extract it from a
 * screenshot, and it goes to console.error for anyone with devtools open.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    /* keep the failure visible in the browser console */
    // eslint-disable-next-line no-console
    console.error("[avaira] render error:", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = String(error?.message || error);
    const stack = String(error?.stack || "").split("\n").slice(0, 4).join("\n");

    return (
      <div
        className="min-h-screen bg-avaira-bg p-6 sm:p-10"
        data-testid="app-error-boundary"
        role="alert"
      >
        <div className="cyber-card p-6 max-w-2xl mx-auto">
          <p className="font-mono text-[10px] text-avaira-dim uppercase tracking-[0.22em]">
            AVaira — boundary
          </p>
          <h1 className="page-title mt-2 text-lg">Something broke on this page.</h1>
          <p className="font-mono text-xs text-avaira-muted mt-2">
            The console hit an unexpected error. The rest of the app is fine —
            reload and try again, and if it keeps happening, send this message
            to the team:
          </p>
          <p
            className="font-mono text-xs mt-4 p-3 border border-avaira-red/40 bg-avaira-red/5 text-avaira-red break-all"
            data-testid="app-error-message"
          >
            {message}
          </p>
          {stack && (
            <pre
              className="font-mono text-[10px] mt-2 p-3 border border-avaira-border bg-avaira-inset text-avaira-dim overflow-x-auto"
              data-testid="app-error-stack"
            >
              {stack}
            </pre>
          )}
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              className="cyber-btn bg-avaira-primary text-white px-4 py-2 font-heading text-sm"
              onClick={() => window.location.reload()}
              data-testid="app-error-reload"
            >
              RELOAD
            </button>
            <button
              type="button"
              className="cyber-btn bg-transparent border border-avaira-border text-avaira-muted px-4 py-2 font-heading text-sm"
              onClick={() => this.setState({ error: null })}
              data-testid="app-error-dismiss"
            >
              TRY AGAIN
            </button>
          </div>
        </div>
      </div>
    );
  }
}
