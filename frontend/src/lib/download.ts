/**
 * triggerDownload — save a Blob to the user's filesystem.
 *
 * In Tauri (desktop app) the standard `<a download>` trick does not work because
 * the WebView doesn't pipe anchor clicks to the OS download manager.  Instead we
 * use the native save-file dialog (`@tauri-apps/api/dialog`) and write the data
 * with the Tauri fs API.
 *
 * In browser dev mode (no Tauri host) we fall back to the conventional approach.
 */

/** True when the code is running inside a Tauri desktop window. */
const inTauri = typeof window !== "undefined" && "__TAURI__" in window;

export async function triggerDownload(blob: Blob, filename: string): Promise<void> {
  if (inTauri) {
    await tauriSave(blob, filename);
  } else {
    browserDownload(blob, filename);
  }
}

// ── Tauri path ────────────────────────────────────────────────────────────────

async function tauriSave(blob: Blob, filename: string): Promise<void> {
  // Dynamic import keeps the browser bundle free of Tauri-only code.
  const { save } = await import("@tauri-apps/api/dialog");
  const { writeBinaryFile } = await import("@tauri-apps/api/fs");

  // Derive a sensible file-type filter from the extension
  const ext = filename.split(".").pop() ?? "*";
  const filterName = ext === "csv" ? "CSV Files" : ext === "json" ? "JSON Files" : "Files";

  const destPath = await save({
    defaultPath: filename,
    filters: [
      { name: filterName, extensions: [ext] },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (!destPath) return; // user cancelled

  const buffer = await blob.arrayBuffer();
  await writeBinaryFile(destPath, buffer);
}

// ── Browser fallback ──────────────────────────────────────────────────────────

function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
