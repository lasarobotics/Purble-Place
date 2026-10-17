export const DEFAULT_HOTKEYS = { auto: "a", teleop: "s", made: "q", missed: "w", undo: "z", clear: "x" };
export type Hotkeys = typeof DEFAULT_HOTKEYS;
export const HOTKEY_LABELS: Record<keyof Hotkeys, string> = { auto: "Select auto", teleop: "Select teleop", made: "Select made", missed: "Select missed", undo: "Undo attempt", clear: "Clear attempts" };
export function validHotkeys(keys: Hotkeys) {
  const values = (["auto", "teleop", "undo", "clear"] as (keyof Hotkeys)[]).map(k => keys[k]);
  return values.every(v => /^[a-z0-9]$/.test(v)) && new Set(values).size === values.length;
}
export function ignoreHotkey(e: KeyboardEvent) {
  return e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey ||
    (e.target instanceof HTMLElement && !!e.target.closest("input,textarea,select,[contenteditable=true],[role=dialog]"));
}
