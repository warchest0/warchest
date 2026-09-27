/**
 * Live READ-ONLY smoke test (S5.1): Robinhood mainnet RPC, Hyperliquid mainnet `/info`, Across public API.
 * No key, no transaction, no order. Prints what the keeper would see. Exit code 1 on any failure.
 *
 *   npx tsx scripts/smoke.ts [VAULT] [GOVERNANCE]
 *
 * Without a deployed vault it still exercises the RPC (chain id, block, USDG/WETH balances of the SpokePool),
 * Hyperliquid meta/mids/clearinghouseState and Across limits/suggested-fees on the D5 route.
 */
import { createPublicClient, getAddress, http } from "viem";
import { HttpAcrossApi, HYPEREVM_CHAIN_ID, USDC_HYPEREVM, USDG_ROBINHOOD } from "../src/across/api.js";
import { ERC20_ABI, QUOTER_V2_ABI, SPOKE_POOL_ABI, WETH_ROBINHOOD } from "../src/chain/abi.js";
import { RpcChainReader } from "../src/chain/reader.js";
import { HL_MAINNET_INFO, QUOTER_V2 } from "../src/config.js";
import { HttpHyperliquidInfo, perpByIndex } from "../src/hyperliquid/info.js";
import { protectionPrices } from "../src/planner.js";
import { roundPrice } from "../src/hyperliquid/rounding.js";

const RPC = process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SPOKE_POOL = getAddress("0xD29C85F15DF544bA632C9E25829fd29d767d7978");
const usd = (x: bigint) => (Number(x) / 1e6).toFixed(2);

async function main() {
  const t0 = Date.now();
  const client = createPublicClient({ transport: http(RPC) });
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  console.log(`[rpc] chainId=${chainId} block=${block.number} ts=${block.timestamp} (${new Date(Number(block.timestamp) * 1000).toISOString()})`);
  if (chainId !== 4663) throw new Error("not Robinhood mainnet");
  const [nDeposits, qBuf, fBuf, spokeUsdg] = await Promise.all([
    client.readContract({ address: SPOKE_POOL, abi: SPOKE_POOL_ABI, functionName: "numberOfDeposits" }),
    client.readContract({ address: SPOKE_POOL, abi: SPOKE_POOL_ABI, functionName: "depositQuoteTimeBuffer" }),
    client.readContract({ address: SPOKE_POOL, abi: SPOKE_POOL_ABI, functionName: "fillDeadlineBuffer" }),
    client.readContract({ address: USDG_ROBINHOOD, abi: ERC20_ABI, functionName: "balanceOf", args: [SPOKE_POOL] }),
  ]);
  console.log(`[across spoke pool] numberOfDeposits=${nDeposits} depositQuoteTimeBuffer=${qBuf} fillDeadlineBuffer=${fBuf} usdg=${usd(spokeUsdg)}`);
  const { result: quote } = await client.simulateContract({
    address: QUOTER_V2,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: WETH_ROBINHOOD, tokenOut: USDG_ROBINHOOD, amountIn: 10n ** 18n, fee: 100, sqrtPriceLimitX96: 0n }],
  });
  console.log(`[quoter v2] 1 ETH → ${usd(quote[0])} USDG (v3 0.01% pool)`);

  const vault = process.argv[2];
  const governance = process.argv[3];
  if (vault && governance) {
    const reader = new RpcChainReader(RPC, getAddress(vault), getAddress(governance), QUOTER_V2);
    const [v, g] = await Promise.all([reader.vault(), reader.governance()]);
    console.log(`[vault] paused=${v.paused} nav=${usd(v.nav)} ledger=${usd(v.usdgLedger)} eth=${v.ethBalance} cap=${usd(v.maxOrderAmount)} position=${v.position.decisionId} risk=${JSON.stringify(v.risk)} recipient=${v.bridgeRecipient}`);
    console.log(`[governance] decision=${g.decision.id} asset=${g.decision.asset} side=${g.decision.side} paused=${g.paused}`);
  } else {
    console.log("[vault] skipped (pass VAULT GOVERNANCE addresses to read a deployment)");
  }

  const hl = new HttpHyperliquidInfo(HL_MAINNET_INFO);
  const [universe, mids] = await Promise.all([hl.meta(), hl.allMids()]);
  console.log(`[hl] universe=${universe.length} perps`);
  for (const i of [0, 1, 5]) {
    const p = perpByIndex(universe, i);
    const mid = mids[p.name] ?? "?";
    const { stopLossPx, takeProfitPx } = protectionPrices(mid, "long", { stopLossBps: 500, leverage: 3, takeProfitBps: 1000 }, p.szDecimals);
    console.log(`[hl] ${i}=${p.name} szDecimals=${p.szDecimals} maxLev=${p.maxLeverage} mid=${mid} → long 3x: entry≤${roundPrice(mid, p.szDecimals, "up")} stop=${stopLossPx} tp=${takeProfitPx}`);
  }
  const state = await hl.clearinghouseState(getAddress("0x0000000000000000000000000000000000000001"));
  console.log(`[hl] clearinghouseState(0x…01) accountValue=${state.accountValue} positions=${state.positions.length}`);
  const agents = await hl.extraAgents(getAddress("0x0000000000000000000000000000000000000001"));
  console.log(`[hl] extraAgents(0x…01)=${agents.length}`);

  const across = new HttpAcrossApi("https://app.across.to/api");
  const route = { inputToken: USDG_ROBINHOOD, outputToken: USDC_HYPEREVM, originChainId: 4663n, destinationChainId: HYPEREVM_CHAIN_ID };
  const limits = await across.limits(route);
  console.log(`[across] 4663 USDG → 999 USDC: min=${usd(limits.minDeposit)} maxInstant=${usd(limits.maxDepositInstant)} max=${usd(limits.maxDeposit)}`);
  for (const amt of [10_000n, 100_000n]) {
    const q = await across.suggestedFees(route, amt * 10n ** 6n);
    const feeBps = Number(((amt * 10n ** 6n - q.outputAmount) * 10_000n) / (amt * 10n ** 6n));
    console.log(`[across] ${amt}$ → out=${usd(q.outputAmount)} fee=${feeBps}bps eta=${q.estimatedFillTimeSec}s quoteTs=${q.timestamp} fillDeadline=${q.fillDeadline} (+${q.fillDeadline - q.timestamp}s) spoke=${q.spokePoolAddress}`);
  }
  const back = { inputToken: USDC_HYPEREVM, outputToken: USDG_ROBINHOOD, originChainId: HYPEREVM_CHAIN_ID, destinationChainId: 4663n };
  const backLimits = await across.limits(back);
  console.log(`[across] 999 USDC → 4663 USDG (return): min=${usd(backLimits.minDeposit)} maxInstant=${usd(backLimits.maxDepositInstant)} max=${usd(backLimits.maxDeposit)}`);
  const ds = await across.depositStatus(4663n, 0n);
  console.log(`[across] deposit/status(4663, 0) = ${ds.status}`);
  console.log(`smoke ok in ${Date.now() - t0}ms`);
}

main().catch((e) => {
  console.error("smoke FAILED", e);
  process.exit(1);
});
