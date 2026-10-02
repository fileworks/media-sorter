/**
 * Editing the library's roots: adding one, repointing one, removing one.
 *
 * This is the Sources panel's form state, not stage orchestration, and
 * `docs/architecture-ownership.md` puts panel-specific forms outside the
 * desktop-navigation seam on purpose. It lived in `MainPage` anyway, where it
 * was four callbacks and a dialog's worth of state between the stage gates and
 * the render.
 *
 * Both builds land in `applyFolder`: the packaged shell opens the OS picker,
 * a browser gets the in-app folder browser, and neither gets its own idea of
 * what a chosen path means.
 */

import { useCallback, useState } from "react";

import type { RootCard, RootRole } from "@/lib/sourcesStage";
import { isTauri } from "@/lib/utils";
import type { Config } from "@/types/api";

/** What a folder request is for: a new root in a role, or an existing one. */
export type FolderTarget = { kind: "add"; role: RootRole } | { kind: "change"; rootId: string };

interface UseRootFoldersOptions {
  config: Config | null | undefined;
  cards: RootCard[];
  /** Writes the patch through the page's own invalidation rules. */
  saveConfig: (patch: Partial<Config>) => void;
  /** The OS picker failed; the page owns how that is announced. */
  onPickerFailed: () => void;
}

export function useRootFolders({
  config,
  cards,
  saveConfig,
  onPickerFailed,
}: UseRootFoldersOptions) {
  const [folderPrompt, setFolderPrompt] = useState<FolderTarget | null>(null);

  const changeRoots = useCallback(
    (nextCards: RootCard[]) => {
      if (!config) return;
      const roots = nextCards.map((card) => {
        const existing = config.library_profile.roots.find((root) => root.root_id === card.rootId);
        return {
          root_id: card.rootId,
          role: card.role,
          path: card.path,
          display_name: card.displayName,
          priority: card.priority,
          exclusions: card.exclusions,
          identity: existing?.identity ?? null,
        };
      });
      saveConfig({
        source_directory: roots.find((root) => root.role === "input")?.path ?? "",
        target_directory: roots.find((root) => root.role === "destination")?.path ?? "",
        library_profile: { ...config.library_profile, roots },
      });
    },
    [config, saveConfig],
  );

  /** Where a chosen path lands: appended as a new root, or replacing one. */
  const applyFolder = useCallback(
    (target: FolderTarget, path: string) => {
      if (target.kind === "change") {
        changeRoots(
          cards.map((card) =>
            card.rootId === target.rootId ? { ...card, path, volume: null } : card,
          ),
        );
        return;
      }
      changeRoots([
        ...cards,
        {
          rootId: `${target.role}-${Date.now()}`,
          role: target.role,
          path,
          displayName: null,
          // Priority is no longer written: the reorder controls are gone and
          // nothing consumes the order. The field stays in the model.
          priority: 0,
          exclusions: [],
          state: "unknown",
          volume: null,
          freshness: "unknown",
          indexedFiles: null,
          issueCount: 0,
        },
      ]);
    },
    [cards, changeRoots],
  );

  const requestFolder = useCallback(
    async (target: FolderTarget) => {
      if (!isTauri) {
        setFolderPrompt(target);
        return;
      }
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected === "string") applyFolder(target, selected);
      } catch {
        onPickerFailed();
      }
    },
    [applyFolder, onPickerFailed],
  );

  const removeFolder = useCallback(
    (rootId: string) => changeRoots(cards.filter((card) => card.rootId !== rootId)),
    [cards, changeRoots],
  );

  /** What the in-app browser needs to open at the right place, in the right mode. */
  const prompt = folderPrompt;
  const promptCard =
    prompt?.kind === "change" ? cards.find((card) => card.rootId === prompt.rootId) : undefined;

  return {
    changeRoots,
    requestFolder,
    removeFolder,
    folderBrowser: {
      open: prompt !== null,
      initialPath: promptCard?.path ?? "",
      requireWritable:
        prompt?.kind === "change"
          ? promptCard?.role === "destination"
          : prompt?.role === "destination",
      onSelect: (path: string) => prompt && applyFolder(prompt, path),
      onClose: () => setFolderPrompt(null),
    },
  };
}
