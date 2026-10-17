"use client";
import { useEffect } from "react";
import { confetti } from "@tsparticles/confetti";

export function PineappleCelebration({ variant, onClose }: { variant: number; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 5200);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      void confetti({ count: 110, spread: 90, startVelocity: 34, position: { x: 50, y: 58 }, colors: ["#7c3aed", "#a855f7", "#ffffff"], zIndex: 500 });
    }
    return () => window.clearTimeout(timer);
  }, [onClose]);
  const labels = ["Great scouting!", "Report saved!", "Nice work!", "Good luck, Purple Haze!", "Ready for the next match!"];
  return <div className="pineapple-back" role="dialog" aria-modal="true" aria-label="Scouting report saved">
    <div className="pineapple-card">
      <img className="pineapple-gif" src={`/pineapples/pineapple${(variant % 5) + 1}.gif`} alt="PurpleScout pineapple celebrating" />
      <h2>{labels[variant % labels.length]}</h2>
      <p>Your scouting report is safe.</p>
      <button className="btn primary" onClick={onClose}>Keep scouting</button>
    </div>
  </div>;
}
