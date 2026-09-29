"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { isDemo } from "@/config/env";
import { DEMO_ACCOUNT } from "@/data/mock";

/**
 * The account whose data is shown: the connected wallet or, in demo mode only, a preview wallet so visitors can
 * explore the dashboard without connecting anything.
 */
interface Viewer {
  account?: Address;
  connected: boolean;
  preview: boolean;
  setPreview: (v: boolean) => void;
}

const Ctx = createContext<Viewer>({ connected: false, preview: false, setPreview: () => {} });

export function ViewerProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const [preview, setPreview] = useState(false);
  // `?preview=1` opens the demo preview wallet directly (handy for sharing the demo)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL is only readable after hydration
    if (isDemo && new URLSearchParams(window.location.search).get("preview") === "1") setPreview(true);
  }, []);
  const value = useMemo<Viewer>(() => {
    if (isConnected && address) return { account: address, connected: true, preview: false, setPreview };
    if (isDemo && preview) return { account: DEMO_ACCOUNT, connected: false, preview: true, setPreview };
    return { connected: false, preview: false, setPreview };
  }, [address, isConnected, preview]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useViewer(): Viewer {
  return useContext(Ctx);
}
