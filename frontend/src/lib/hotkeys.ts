export const DEFAULT_HOTKEYS = { auto: "a", teleop: "t", made: "m", missed: "x", undo: "u", foul: "f", stop: "s", leave: "l" };
export type Hotkeys = typeof DEFAULT_HOTKEYS;
export const HOTKEY_LABELS: Record<keyof Hotkeys, string> = { auto: "Select auto", teleop: "Select teleop", made: "Select made", missed: "Select missed", undo: "Undo attempt", foul: "Add foul", stop: "Add defensive stop", leave: "Toggle auto leave" };
export function validHotkeys(keys: Hotkeys) {
  const values = Object.keys(DEFAULT_HOTKEYS).map(k => keys[k as keyof Hotkeys]);
  return values.every(v => /^[a-z0-9]$/.test(v)) && new Set(values).size === values.length;
}
export function ignoreHotkey(e: KeyboardEvent) {
  return e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey ||
    (e.target instanceof HTMLElement && !!e.target.closest("input,textarea,select,button,[contenteditable=true],[role=dialog]"));
}
