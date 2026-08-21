"use client";
// Device battery level, for the status pill next to Live/Offline.
//
// Scouting runs for eight hours on borrowed Chromebooks and phones, and the
// thing that actually ends a scout's day is a flat battery. Showing the level
// where they already look for "am I online" makes it visible before it is a
// problem.
//
// The Battery Status API is Chromium-only (Chrome, Edge, Android WebView) and
// deliberately absent from Firefox and Safari. That covers the devices the
// team hands out; everywhere else the hook returns null and the pill simply
// does not render, rather than showing a made-up number.
import { useEffect, useState } from "react";

interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
}

export interface BatteryState {
  /** 0-100, rounded. */
  percent: number;
  charging: boolean;
}

export function useBattery(): BatteryState | null {
  const [state, setState] = useState<BatteryState | null>(null);

  useEffect(() => {
    const getBattery = (navigator as any)?.getBattery;
    if (typeof getBattery !== "function") return;

    let alive = true;
    let battery: BatteryLike | null = null;
    const read = () => {
      if (!alive || !battery) return;
      setState({ percent: Math.round(battery.level * 100), charging: battery.charging });
    };

    getBattery.call(navigator).then((b: BatteryLike) => {
      if (!alive) return;
      battery = b;
      read();
      b.addEventListener("levelchange", read);
      b.addEventListener("chargingchange", read);
    }).catch(() => {});

    return () => {
      alive = false;
      battery?.removeEventListener("levelchange", read);
      battery?.removeEventListener("chargingchange", read);
    };
  }, []);

  return state;
}
