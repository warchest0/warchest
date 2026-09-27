/**
 * Hyperliquid L1-action signing (the ONLY signing scheme this keeper knows).
 *
 *   hash  = keccak256(msgpack(action) ‖ nonce(8 bytes BE) ‖ (0x00 | 0x01 ‖ vaultAddress) ‖ [0x00 ‖ expiresAfter(8 BE)])
 *   agent = { source: "a" (mainnet) | "b" (testnet), connectionId: hash }
 *   sig   = EIP-712 sign(domain { name "Exchange", version "1", chainId 1337, verifyingContract 0x0 }, Agent)
 *
 * Verified byte-for-byte against the Hyperliquid Python SDK test vectors (`tests/signing_test.py`) and against the
 * testnet `/exchange` endpoint (recovered-address proof, see `scripts/sigproof.ts`).
 *
 * SECURITY: an API wallet (agent) may only sign L1 actions. User-signed actions (`withdraw3`, `usdSend`,
 * `spotSend`, `sendAsset`, `usdClassTransfer`, `approveAgent`, `approveBuilderFee`, `vaultTransfer`,
 * `subAccountTransfer`, `convertToMultiSigUser`…) use a different EIP-712 domain (`HyperliquidSignTransaction`) that
 * this module does not implement, AND every action type outside {@link L1_ACTION_ALLOWLIST} is refused here, before
 * anything is hashed. Rotating the agent key can therefore never grant withdrawal rights to this process.
 */
import { concatBytes, hexToBytes, keccak256, parseSignature, toHex, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { encodeMsgpack, type Packable } from "./msgpack.js";

/** The only action types the keeper will ever sign. */
export const L1_ACTION_ALLOWLIST = Object.freeze([
  "order",
  "cancel",
  "cancelByCloid",
  "modify",
  "batchModify",
  "updateLeverage",
  "updateIsolatedMargin",
  "scheduleCancel",
] as const);

export type AllowedActionType = (typeof L1_ACTION_ALLOWLIST)[number];

export interface L1Action {
  type: string;
  [key: string]: Packable;
}

export class ForbiddenActionError extends Error {
  constructor(readonly actionType: unknown) {
    super(`refusing to sign Hyperliquid action type ${JSON.stringify(actionType)}: not in the trading-only allowlist`);
  }
}

export function assertAllowedAction(action: unknown): asserts action is L1Action & { type: AllowedActionType } {
  if (typeof action !== "object" || action === null || Array.isArray(action)) throw new ForbiddenActionError(action);
  const t = (action as { type?: unknown }).type;
  if (typeof t !== "string" || !(L1_ACTION_ALLOWLIST as readonly string[]).includes(t)) throw new ForbiddenActionError(t);
  // a user-signed action always carries these; refuse them even under an allowed `type`
  for (const k of ["signatureChainId", "hyperliquidChain", "destination", "amount", "agentAddress", "builder"]) {
    if (k in action) throw new ForbiddenActionError(`${t} with field ${k}`);
  }
}

export interface SignOptions {
  /** Sub-account / vault traded on behalf of (the action's `vaultAddress`). */
  vaultAddress?: Address;
  /** Ms timestamp after which the API must reject the action. */
  expiresAfter?: number;
}

const be64 = (n: number | bigint): Uint8Array => {
  const v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error("nonce/expiresAfter out of range");
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) out[i] = Number((v >> BigInt(8 * (7 - i))) & 0xffn);
  return out;
};

/** `action_hash` of the Python SDK. */
export function actionHash(action: L1Action, nonce: number, opts: SignOptions = {}): Hex {
  const parts: Uint8Array[] = [encodeMsgpack(action), be64(nonce)];
  if (opts.vaultAddress) parts.push(new Uint8Array([1]), hexToBytes(opts.vaultAddress));
  else parts.push(new Uint8Array([0]));
  if (opts.expiresAfter !== undefined) parts.push(new Uint8Array([0]), be64(opts.expiresAfter));
  return keccak256(concatBytes(parts));
}

export const EXCHANGE_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

export const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const;

export function phantomAgent(hash: Hex, isMainnet: boolean): { source: "a" | "b"; connectionId: Hex } {
  return { source: isMainnet ? "a" : "b", connectionId: hash };
}

export interface Signature {
  r: Hex;
  s: Hex;
  v: 27 | 28;
}

export interface L1Signer {
  readonly address: Address;
  readonly isMainnet: boolean;
  sign(action: L1Action, nonce: number, opts?: SignOptions): Promise<Signature>;
}

/** Signs allowlisted L1 actions with an agent key. There is no method for any other kind of signature. */
export class AgentSigner implements L1Signer {
  readonly address: Address;
  constructor(private readonly account: PrivateKeyAccount, readonly isMainnet: boolean) {
    this.address = account.address;
  }

  async sign(action: L1Action, nonce: number, opts: SignOptions = {}): Promise<Signature> {
    assertAllowedAction(action);
    const hash = actionHash(action, nonce, opts);
    const sig = await this.account.signTypedData({
      domain: EXCHANGE_DOMAIN,
      types: AGENT_TYPES,
      primaryType: "Agent",
      message: phantomAgent(hash, this.isMainnet),
    });
    return splitSignature(sig);
  }
}

export function splitSignature(sig: Hex): Signature {
  const { r, s, v, yParity } = parseSignature(sig);
  const vv = v !== undefined ? Number(v) : yParity === 1 ? 28 : 27;
  if (vv !== 27 && vv !== 28) throw new Error(`unexpected v ${vv}`);
  return { r: toHex(BigInt(r)), s: toHex(BigInt(s)), v: vv };
}
