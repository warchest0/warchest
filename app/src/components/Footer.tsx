import Link from "next/link";
import { brand } from "@/config/brand";
import { env, isDemo } from "@/config/env";
import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="mt-24 border-t border-border/70 pb-28 pt-12 lg:pb-12">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">{brand.description}</p>
          <p className="mt-4 max-w-md text-xs leading-relaxed text-muted/80">
            Not financial advice. The treasury trades leveraged perpetual futures: it can lose money, including all of
            the capital committed to a position. Smart contracts are not yet audited.
          </p>
        </div>
        <div>
          <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">App</h3>
          <ul className="mt-4 space-y-2 text-sm">
            <li><Link className="text-fg/80 hover:text-fg" href="/dashboard/">Dashboard</Link></li>
            <li><Link className="text-fg/80 hover:text-fg" href="/vote/">Vote</Link></li>
            <li><Link className="text-fg/80 hover:text-fg" href="/treasury/">Treasury</Link></li>
            <li><Link className="text-fg/80 hover:text-fg" href="/leaderboard/">Leaderboard</Link></li>
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted">Protocol</h3>
          <ul className="mt-4 space-y-2 text-sm">
            {brand.links.github && <li><a className="text-fg/80 hover:text-fg" href={brand.links.github} target="_blank" rel="noreferrer">Source code</a></li>}
            {brand.links.docs && <li><a className="text-fg/80 hover:text-fg" href={brand.links.docs} target="_blank" rel="noreferrer">Documentation</a></li>}
            {brand.links.x && <li><a className="text-fg/80 hover:text-fg" href={brand.links.x} target="_blank" rel="noreferrer">X</a></li>}
            <li className="text-muted">
              {env.chain.name} · {isDemo ? "demo mode" : `chain ${env.chainId}`}
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
