import { createContext, useContext } from "react";

import type { Config } from "@/types/api";

/**
 * What a `SettingRow` needs to say "you changed this" and to offer a way back.
 *
 * A row knows which `Config` fields it edits — it declares them through
 * `field` — but it cannot know what the factory default for those fields is,
 * nor how to write one back. Both answers live on the Configure screen, which
 * holds the backend's own defaults and owns the reset dialog, so they are
 * supplied through context rather than threaded as three extra props through
 * every one of the forty-odd rows.
 *
 * Absent provider means "no diff information available" — the rows render
 * exactly as they did before, with no marker.
 */
export interface SettingsDiffValue {
  /** Config keys whose live value differs from the factory default. */
  changed: ReadonlySet<string>;
  /** The factory defaults, as served by `GET /api/config/defaults`. */
  defaults: Partial<Config>;
  /**
   * Put these fields back to their defaults — after showing what that would
   * change. Never writes without confirmation.
   */
  revert: (fields: readonly (keyof Config)[]) => void;
  /** Settings are locked while an operation runs; the marker stays, the control goes. */
  locked: boolean;
}

// Its own non-component module so the provider file can export only components,
// which is what React Fast Refresh (and the react-refresh lint rule) needs.
export const SettingsDiffContext = createContext<SettingsDiffValue | null>(null);

export const useSettingsDiff = (): SettingsDiffValue | null => useContext(SettingsDiffContext);
