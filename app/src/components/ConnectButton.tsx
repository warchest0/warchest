"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { env } from "@/config/env";
import { shortAddr } from "@/lib/format";
import { useViewer } from "@/hooks/useViewer";
import { IconChevron, IconWallet } from "./icons";
import { Avatar } from "./ui/Avatar";
import { Button, cx } from "./ui/primitives";

/** Injected-wallet connect button with a wrong-network guard and a small account menu. */
export function ConnectButton({ className }: { className?: string }) {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { preview, setPreview } = useViewer();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- wallet state only exists after hydration
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!mounted) return <div className={cx("h-10 w-32 rounded-xl bg-surface-2", className)} />;

  if (isConnected && address) {
    if (chainId !== env.chainId) {
      return (
        <Button variant="secondary" className={cx("text-warm", className)} onClick={() => switchChain({ chainId: env.chainId })}>
          Switch to {env.chain.name}
        </Button>
      );
    }
    return (
      <div ref={ref} className={cx("relative", className)}>
        <Button variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
          <Avatar address={address} size={20} />
          <span className="num">{shortAddr(address)}</span>
          <IconChevron className="text-muted" />
        </Button>
        {open && (
          <div role="menu" className="absolute right-0 z-50 mt-2 w-48 rounded-xl border border-border bg-surface p-1 shadow-2xl">
            <button
              role="menuitem"
              className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-fg"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  const injectedConnectors = connectors.filter((c) => c.type === "injected");
  // prefer a discovered EIP-6963 wallet over the generic "Injected" fallback
  const connector = injectedConnectors.find((c) => c.id !== "injected") ?? injectedConnectors[0];

  return (
    <div className={cx("flex items-center gap-2", className)}>
      {preview && (
        <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => setPreview(false)}>
          Exit preview
        </Button>
      )}
      <Button
        onClick={() => connector && connect({ connector, chainId: env.chainId })}
        disabled={!connector || isPending}
        title={error?.message ?? (connector ? undefined : "No browser wallet detected")}
      >
        <IconWallet />
        {isPending ? "Connecting…" : connector ? "Connect" : "No wallet"}
      </Button>
    </div>
  );
}
