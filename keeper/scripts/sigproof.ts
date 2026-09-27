/**
 * Signature proof against the Hyperliquid TESTNET `/exchange` endpoint.
 *
 * A fresh random key (unfunded, never registered) signs allowlisted actions with our in-house signer and submits
 * them. The API rejects each one with "User or API Wallet 0x… does not exist." — the address it RECOVERED from the
 * EIP-712 signature. If our msgpack action hash, phantom agent, nonce / vaultAddress / expiresAfter framing or domain
 * were off by a single byte, the recovered address would not be ours. A deliberately tampered payload is sent as a
 * negative control (it must recover a DIFFERENT address).
 *
 * Nothing can be executed: the key has no account, no funds, no agent approval. Run sparingly (5 requests).
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { HL_TESTNET_EXCHANGE } from "../src/config.js";
import { wire } from "../src/hyperliquid/exchange.js";
import { AgentSigner, type L1Action, type SignOptions } from "../src/hyperliquid/signer.js";

const account = privateKeyToAccount(generatePrivateKey());
const signer = new AgentSigner(account, false);
const url = process.env.HL_EXCHANGE_URL ?? HL_TESTNET_EXCHANGE;

async function submit(label: string, action: L1Action, opts: SignOptions & { tamper?: boolean } = {}) {
  const nonce = Date.now();
  const signature = await signer.sign(action, nonce, { vaultAddress: opts.vaultAddress, expiresAfter: opts.expiresAfter });
  const payload: Record<string, unknown> = { action, nonce, signature };
  if (opts.vaultAddress) payload.vaultAddress = opts.vaultAddress;
  if (opts.expiresAfter !== undefined) payload.expiresAfter = opts.expiresAfter;
  if (opts.tamper) payload.nonce = nonce + 1; // signature no longer matches → different recovered address
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const text = await res.text();
  const m = /(0x[0-9a-fA-F]{40})/.exec(text);
  const recovered = m?.[1]?.toLowerCase();
  const ours = account.address.toLowerCase();
  const ok = opts.tamper ? recovered !== undefined && recovered !== ours : recovered === ours;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: HTTP ${res.status} ${text.trim().slice(0, 160)}`);
  console.log(`      recovered=${recovered ?? "none"} ours=${ours}${opts.tamper ? " (negative control: must differ)" : ""}`);
  return ok;
}

async function main() {
  console.log(`signature proof against ${url} with throwaway agent ${account.address}`);
  const order = wire.order([{ asset: 1, isBuy: true, limitPx: "1000", size: "0.01", reduceOnly: false, type: { limit: { tif: "Ioc" } }, cloid: "0x000000000000000000000000000000ab" }]);
  const results = [
    await submit("order (no vault, no expiry)", order),
    await submit("order + expiresAfter", order, { expiresAfter: Date.now() + 60_000 }),
    await submit("order + vaultAddress (sub-account) + expiresAfter", order, { vaultAddress: "0x1719884eb866cb12b2287399b15f7db5e7d775ea", expiresAfter: Date.now() + 60_000 }),
    await submit("updateLeverage isolated 3x + vaultAddress", wire.updateLeverage(1, false, 3), { vaultAddress: "0x1719884eb866cb12b2287399b15f7db5e7d775ea" }),
    await submit("tampered nonce", order, { expiresAfter: Date.now() + 60_000, tamper: true }),
  ];
  const pass = results.every(Boolean);
  console.log(pass ? "ALL PASS: the signer is byte-correct" : "FAILURE");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
