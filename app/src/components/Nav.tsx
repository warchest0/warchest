"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { IconGauge, IconTrophy, IconVault, IconVote } from "./icons";
import { Logo } from "./Logo";
import { DemoBadge, cx } from "./ui/primitives";

export const NAV = [
  { href: "/dashboard/", label: "Dashboard", icon: IconGauge },
  { href: "/vote/", label: "Vote", icon: IconVote },
  { href: "/treasury/", label: "Treasury", icon: IconVault },
  { href: "/leaderboard/", label: "Leaderboard", icon: IconTrophy },
] as const;

function useActive() {
  const path = usePathname() ?? "/";
  return (href: string) => path === href || path === href.replace(/\/$/, "") || path.startsWith(href);
}

export function TopNav() {
  const active = useActive();
  return (
    <header
      className="sticky z-40 border-b border-border/70 bg-bg/75 backdrop-blur-xl"
      style={{ top: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Home is the separately built static marketing site. */}
        <a href="/" className="shrink-0 rounded-lg" aria-label="Home">
          <Logo />
        </a>
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className={cx(
                "rounded-lg px-3 py-2 text-sm transition-colors",
                active(n.href) ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <DemoBadge className="hidden sm:inline-flex" />
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}

/** App-style tab bar on phones. */
export function BottomNav() {
  const active = useActive();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-bg/85 backdrop-blur-xl md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="mx-auto grid max-w-md grid-cols-4">
        {NAV.map((n) => {
          const on = active(n.href);
          const Icon = n.icon;
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={on ? "page" : undefined}
              className={cx("flex flex-col items-center gap-1 py-2.5 text-[11px]", on ? "text-accent" : "text-muted")}
            >
              <Icon className="text-xl" />
              {n.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
