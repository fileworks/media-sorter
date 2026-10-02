/**
 * Whether the settings on screen are being read rather than edited.
 *
 * The lock itself is enforced by a native `fieldset[disabled]` around the
 * region, which is what actually stops every control inside it. This context
 * exists so the *chrome* around those controls can say so too — a sticky group
 * heading that never mentions it leaves a reader scrolled past the one banner
 * looking at rows that appear ordinary.
 *
 * It is advisory. Nothing may rely on it to prevent an edit.
 */
import { createContext, useContext } from "react";

export const SettingsLockContext = createContext(false);

export function useSettingsLocked(): boolean {
  return useContext(SettingsLockContext);
}
