"use client";
import { useRef, useState, useEffect } from "react";
import { Modal } from "./ui";

export function usePicklistConfirm() {
  const [message, setMessage] = useState("");
  const resolve = useRef<((value: boolean) => void) | null>(null);
  const finish = (value: boolean) => { resolve.current?.(value); resolve.current = null; setMessage(""); };
  useEffect(() => () => { resolve.current?.(false); }, []);
  const confirm = (text: string) => new Promise<boolean>(done => { resolve.current?.(false); resolve.current = done; setMessage(text); });
  const confirmation = message ? <Modal dialog onClose={() => finish(false)}><h2>Confirm picklist change</h2><p>{message}</p><div className="btn-row"><button autoFocus className="btn" onClick={() => finish(false)}>Cancel</button><button className="btn primary" onClick={() => finish(true)}>Confirm</button></div></Modal> : null;
  return { confirm, confirmation };
}
