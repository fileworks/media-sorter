import { describe, expect, it } from "vitest";

/**
 * F-12: the packaged client must never guess at a local API.
 *
 * `init()` fell through to `http://127.0.0.1:8000` on *any* IPC failure, in
 * every build — pointing the capability token and every subsequent request at
 * whatever process happens to own port 8000 on the user's machine. Three more
 * ungated fallbacks sat in the synchronous URL builders, and
 * `getWebSocketProtocol()` returned the bare prefix `"mediasorter."` while the
 * capability was still empty.
 *
 * This is a source assertion rather than a behavioural one on purpose: the
 * property is "the string does not appear outside a DEV branch", and that is
 * exactly what a future edit would reintroduce. `import.meta.env.DEV` is
 * replaced by a literal at build time, so a guarded branch is not merely
 * skipped in production — it is absent from the bundle.
 */
const sources = [
  "src/services/api.ts",
  "src/hooks/useLogs.ts",
  "src/lib/thumbnailQueue.ts",
  "src/components/ui/media-image.tsx",
  "src/components/ui/thumbnail.tsx",
  "src/components/screens/review/CompareModal.tsx",
  "src/components/screens/review/MediaViewer.tsx",
] as const;

// Read through Vite rather than `node:fs`: the app has no `@types/node`, and
// adding it to typecheck one test would let app code reach for Node APIs the
// WebView does not have.
const rawSources = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function read(relative: string): string {
  const key = `/${relative}`;
  const source = rawSources[key];
  if (source === undefined) {
    throw new Error(`${key} is not in the source glob; the path moved or is misspelt`);
  }
  return source;
}

describe("no production path may invent a loopback URL", () => {
  it("has no unguarded port-8000 literal in any client source", () => {
    const offenders: string[] = [];

    for (const relative of sources) {
      const lines = read(relative).split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("127.0.0.1:8000") && !line.includes("localhost:8000")) return;
        // A comment describing the defect is not the defect.
        if (/^\s*(\*|\/\/)/.test(line)) return;
        // The only sanctioned occurrence: inside an explicit DEV branch.
        const context = lines.slice(Math.max(0, index - 8), index).join("\n");
        if (context.includes("import.meta.env.DEV")) return;
        offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the dev fallback behind the one flag the bundler can erase", () => {
    const api = read("src/services/api.ts");
    const fallback = api.indexOf("baseUrl: `http://127.0.0.1:8000`");

    expect(fallback).toBeGreaterThan(-1);
    const preceding = api.slice(Math.max(0, fallback - 400), fallback);
    expect(preceding).toContain("import.meta.env.DEV");
  });

  it("never builds a subprotocol from an empty capability", () => {
    const api = read("src/services/api.ts");

    // The old body was a bare template literal over `this.capability`.
    expect(api).not.toMatch(/getWebSocketProtocol\(\): string \{/);
    expect(api).toMatch(/getWebSocketProtocol\(\): string \| null/);
    expect(api).toContain("if (session === null || !session.capability) return null;");
  });

  it("makes every synchronous URL builder refusable", () => {
    const api = read("src/services/api.ts");

    for (const builder of ["getWebSocketUrl", "thumbnailUrl", "diffUrl"]) {
      const signature = new RegExp(`${builder}\\([^)]*\\): string \\| null`);
      expect(api).toMatch(signature);
    }
    // And none of them may fall back to a default any more.
    expect(api).not.toContain('this.http.defaults.baseURL ?? "http://127.0.0.1:8000"');
  });

  it("awaits readiness in the log stream instead of racing a timer", () => {
    const logs = read("src/hooks/useLogs.ts");

    expect(logs).not.toContain("setTimeout(connect, 200)");
    // Written across lines by the formatter, so match the call, not the layout.
    expect(logs.replace(/\s+/g, "")).toContain("api.whenReady()");
  });
});
