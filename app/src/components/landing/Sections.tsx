import { brand, tickerLabel } from "@/config/brand";
import { IconArrowRight, IconChevron, IconShield } from "../icons";
import { ButtonLink } from "../ui/primitives";

const GUARANTEES = [
  { k: "20%", t: "Hard cap per trade", d: "Enforced by the vault contract against the liquid NAV. No deployment can raise it." },
  { k: "0", t: "Ways to withdraw", d: "The vault has no owner and no withdraw function. The keeper's trading key cannot move funds." },
  { k: "6 h", t: "Challenge windows", d: "Weight snapshots and keeper reports can be revoked by the guardian before they count." },
  { k: "100%", t: "On-chain accounting", d: "NAV, orders, returns, PnL and the high-water mark are public contract state." },
];

export function Transparency() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28">
      <div className="relative overflow-hidden rounded-3xl border border-border bg-surface p-6 sm:p-12">
        <div className="glow-bg pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div className="max-w-xl">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-accent">
              <IconShield /> Transparency
            </div>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Verify, don&apos;t trust</h2>
            <p className="mt-4 text-muted">
              Every order, every close and every dollar of profit or loss is readable on-chain. The treasury page shows
              it live, with links to the explorer.
            </p>
          </div>
          <ButtonLink href="/treasury/" variant="secondary">
            Open the treasury <IconArrowRight />
          </ButtonLink>
        </div>
        <div className="relative mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {GUARANTEES.map((g) => (
            <div key={g.t} className="rounded-2xl border border-border bg-bg/50 p-5">
              <div className="num text-3xl font-semibold text-gradient">{g.k}</div>
              <div className="mt-3 font-medium">{g.t}</div>
              <p className="mt-1 text-sm leading-relaxed text-muted">{g.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const FAQ: { q: string; a: string }[] = [
  {
    q: "How is my level computed?",
    a: `Each time you receive ${tickerLabel}, it becomes a lot dated that UTC day. A lot is level 0 on its first day and gains one level at every UTC midnight, up to 10. Your voting weight is the sum of each lot's amount times its level, computed by an open-source indexer and published as a merkle tree every day.`,
  },
  {
    q: "What happens to my level when I sell or transfer?",
    a: "Sales and outgoing transfers consume your most recent lots first (LIFO), so older tokens keep their level. The receiver of a transfer starts a fresh level-0 lot: moving tokens between wallets never carries levels along.",
  },
  {
    q: "Where does the treasury's money come from?",
    a: "From a 10% fee on every buy and sell in the official pool, taken in ETH by a Uniswap v4 hook. There is no fee on transfers or on adding liquidity. The ETH is converted to USDG before being bridged to Hyperliquid for a trade.",
  },
  {
    q: "What if not enough people vote?",
    a: "A new decision needs 10% of the snapshot weight to vote and a single winning option. Otherwise the previous decision stands. A position closed by its stop-loss is never reopened without a new quorate vote.",
  },
  {
    q: "Can the treasury lose money?",
    a: "Yes. Leverage cuts both ways: a 3× position with a 5% stop-loss can lose roughly 15% of the capital committed, and more if the market gaps past the stop. Each trade uses at most 20% of the liquid treasury, but a series of losing trades compounds. Past results say nothing about future ones.",
  },
  {
    q: "Who runs the trades, and what do I have to trust?",
    a: "A keeper bot executes governance decisions on Hyperliquid through an agent key that can trade but cannot withdraw. You still trust it to place the stop-loss and to report honestly: reports have a challenge window, an independent monitor watches it, and the guardian multisig can pause. A compromised agent could still trade badly within the 20% cap.",
  },
  {
    q: "Do holders receive profits?",
    a: "Only realized profit above the high-water mark can ever be distributed, after all previous losses are recovered, and only if the distribution module is enabled at deployment. That choice is pending legal advice; the alternative is buyback and burn.",
  },
  {
    q: "Is this financial advice or an investment product?",
    a: `No. ${brand.name} is experimental software. It is not financial advice, not a fund and not a promise of returns. The contracts are not yet externally audited. Only use money you can afford to lose, and check the rules that apply where you live.`,
  },
];

export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-20 sm:px-6 md:py-28">
      <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted">FAQ</div>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Questions, and honest answers</h2>
      <div className="mt-10 divide-y divide-border rounded-2xl border border-border bg-surface/60">
        {FAQ.map((f) => (
          <details key={f.q} className="group px-5 py-1 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-medium">
              {f.q}
              <IconChevron className="shrink-0 text-muted transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <p className="pb-5 text-sm leading-relaxed text-muted">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6">
      <div className="relative overflow-hidden rounded-3xl border border-border bg-surface px-6 py-16 text-center">
        <div className="glow-bg pointer-events-none absolute inset-0" />
        <div className="relative">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{brand.tagline}</h2>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink href="/dashboard/" className="px-5 py-3">
              Check your level <IconArrowRight />
            </ButtonLink>
            <ButtonLink href="/vote/" variant="secondary" className="px-5 py-3">
              See the live vote
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
