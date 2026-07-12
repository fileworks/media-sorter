import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback; defaults to a built-in recovery card. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level React error boundary. Without it, a render-time throw
 * in any component unmounts the whole tree and leaves a blank window. This
 * catches the error, logs it for diagnosis, and offers a reload instead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console so the crash is diagnosable in dev tools.
    console.error("Uncaught UI error:", error, info.componentStack);
  }

  // Soft reset: clear the error so the subtree re-mounts in place. Recovers
  // from a transient render failure without throwing away in-memory app state
  // (config edits, scroll position) the way a full reload would.
  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center"
      >
        <div className="max-w-md space-y-2">
          <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            The interface hit an unexpected error and couldn&apos;t continue. Reloading usually
            fixes it — your files were not modified.
          </p>
          {error.message && (
            <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
              {error.message}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
