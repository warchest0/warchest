import React from "react";
import { AbsoluteFill } from "remotion";
import { Background, Grain, Inset, SIZE, mono, useT } from "./common";

export const VH = 1920;

// Places a square teaser in the middle of a 1080 × 1920 frame; the frame owns the full-height background.
export function Vertical({ Teaser }: { Teaser: React.ComponentType }) {
  const t = useT();
  return (
    <AbsoluteFill style={{ background: "#080c12" }}>
      <Background t={t} height={VH} glow={0} />
      <div style={{ position: "absolute", left: 0, top: (VH - SIZE) / 2, width: SIZE, height: SIZE }}>
        <Inset.Provider value={true}><Teaser /></Inset.Provider>
      </div>
      <div style={{ position: "absolute", top: 150, width: SIZE, textAlign: "center", fontFamily: mono, fontSize: 24, letterSpacing: "0.5em", color: "rgba(232,237,245,.45)" }}>WARCHEST · $WAR</div>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,.55) 100%)" }} />
      <Grain />
    </AbsoluteFill>
  );
}
