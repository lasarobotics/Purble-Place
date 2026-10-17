"use client";
import { useState } from "react";
import { Modal } from "./ui";
import { DEFAULT_HOTKEYS, HOTKEY_LABELS, Hotkeys, validHotkeys } from "@/lib/hotkeys";

export function HotkeySettings({ keys, onSave, onClose }: { keys: Hotkeys; onSave: (keys: Hotkeys) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(keys);
  return <Modal onClose={onClose}><div role="dialog" aria-modal="true" aria-labelledby="hotkey-title">
    <h2 id="hotkey-title">Scouting hotkeys</h2>
    <p className="muted">Choose a unique letter or number for each action. Changes lock when scouting starts. Field taps record missed shots.</p>
    <div className="grid auto">{(["auto", "teleop", "undo", "clear"] as (keyof Hotkeys)[]).map(action => <label className="field" key={action}>
      <span>{HOTKEY_LABELS[action]}</span><input aria-label={HOTKEY_LABELS[action]} value={draft[action]} maxLength={1}
        onChange={e => setDraft({ ...draft, [action]: e.target.value.toLowerCase() })} />
    </label>)}</div>
    {!validHotkeys(draft) && <p role="alert">Use a different letter or number for every action.</p>}
    <div className="btn-row">
      <button className="btn ghost" onClick={() => setDraft(DEFAULT_HOTKEYS)}>Restore defaults</button>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!validHotkeys(draft)} onClick={() => onSave(draft)}>Save hotkeys</button>
    </div>
  </div></Modal>;
}
