import { encode as refEncode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeMsgpack, type Packable } from "../src/hyperliquid/msgpack.js";
import { NonceSource, orderToWire, wire } from "../src/hyperliquid/exchange.js";
import {
  actionHash,
  AgentSigner,
  AGENT_TYPES,
  assertAllowedAction,
  EXCHANGE_DOMAIN,
  ForbiddenActionError,
  L1_ACTION_ALLOWLIST,
  phantomAgent,
  splitSignature,
} from "../src/hyperliquid/signer.js";

/** Same key as the Hyperliquid Python SDK `tests/signing_test.py`. */
const SDK_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;
const account = privateKeyToAccount(SDK_KEY);

/** Unguarded signing used only to reproduce SDK vectors whose action type ("dummy") is outside our allowlist. */
async function rawSign(action: Parameters<typeof actionHash>[0], nonce: number, isMainnet: boolean, opts?: Parameters<typeof actionHash>[2]) {
  const sig = await account.signTypedData({ domain: EXCHANGE_DOMAIN, types: AGENT_TYPES, primaryType: "Agent", message: phantomAgent(actionHash(action, nonce, opts), isMainnet) });
  return splitSignature(sig);
}

describe("msgpack encoder", () => {
  it("matches @msgpack/msgpack on the action shapes we send", () => {
    const samples: Packable[] = [
      { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" },
      { type: "order", orders: [{ a: 4, b: false, p: "1670.1", s: "0.0147", r: true, t: { trigger: { isMarket: true, triggerPx: "103", tpsl: "sl" } }, c: "0x00000000000000000000000000000001" }], grouping: "positionTpsl" },
      { type: "cancel", cancels: [{ a: 0, o: 123456789 }] },
      { type: "updateLeverage", asset: 255, isCross: false, leverage: 3 },
      { type: "updateIsolatedMargin", asset: 1, isBuy: true, ntli: 1_000_000 },
      { type: "scheduleCancel", time: 1_790_000_000_000 },
      { type: "scheduleCancel" },
      { n: 0, a: 127, b: 128, c: 255, d: 256, e: 65535, f: 65536, g: 4294967295, h: 4294967296, i: -1, j: -32, k: -33, l: -128, m: -129, o: -32768, p: -32769, q: -2147483648, r: -2147483649 },
      { big: 18446744073709551615n, neg: -9223372036854775808n },
      { s31: "x".repeat(31), s32: "x".repeat(32), s256: "y".repeat(256), s70k: "z".repeat(70_000), utf8: "é€🙂" },
      { arr15: Array.from({ length: 15 }, (_, i) => i), arr16: Array.from({ length: 16 }, (_, i) => i), arr70k: Array.from({ length: 70_000 }, () => 1) },
      Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i])),
      Object.fromEntries(Array.from({ length: 70_000 }, (_, i) => [`k${i}`, null])),
      [null, true, false, new Uint8Array([1, 2, 3]), new Uint8Array(300), new Uint8Array(70_000)],
    ];
    // the reference encoder turns JS numbers beyond 32 bits into float64; Hyperliquid (and we) use uint64
    const toRef = (v: Packable): unknown =>
      typeof v === "number" && (v > 0xffffffff || v < -0x80000000) ? BigInt(v)
      : Array.isArray(v) ? v.map(toRef)
      : v && typeof v === "object" && !(v instanceof Uint8Array) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toRef(x)]))
      : v;
    for (const s of samples) {
      expect(Buffer.from(encodeMsgpack(s)).toString("hex")).toBe(Buffer.from(refEncode(toRef(s), { useBigInt64: true })).toString("hex"));
    }
  });
  it("refuses floats and unsafe numbers (a float would silently change the hash)", () => {
    expect(() => encodeMsgpack({ p: 1.5 })).toThrow(/non-integer/);
    expect(() => encodeMsgpack(2 ** 60)).toThrow(/non-integer/);
    expect(() => encodeMsgpack(2n ** 64n)).toThrow(/too large/);
  });
});

describe("L1 action signing = Hyperliquid Python SDK vectors", () => {
  const dummy = { type: "dummy", num: 100_000_000_000 }; // float_to_int_for_hashing(1000)
  it("phantom agent connectionId", () => {
    const order = wire.order([{ asset: 4, isBuy: true, limitPx: "1670.1", size: "0.0147", reduceOnly: false, type: { limit: { tif: "Ioc" } } }]);
    expect(phantomAgent(actionHash(order, 1677777606040), true).connectionId).toBe("0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
  });
  it("test_l1_action_signing_matches", async () => {
    expect(await rawSign(dummy, 0, true)).toEqual({ r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298", s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", v: 27 });
    expect(await rawSign(dummy, 0, false)).toEqual({ r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510", s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", v: 28 });
  });
  it("test_l1_action_signing_matches_with_vault", async () => {
    const vaultAddress = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
    expect(await rawSign(dummy, 0, true, { vaultAddress })).toEqual({ r: "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239", s: "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c", v: 28 });
    expect(await rawSign(dummy, 0, false, { vaultAddress })).toEqual({ r: "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b", s: "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60", v: 27 });
  });
  it("test_l1_action_signing_order_matches (through the guarded AgentSigner)", async () => {
    const order = wire.order([{ asset: 1, isBuy: true, limitPx: "100", size: "100", reduceOnly: false, type: { limit: { tif: "Gtc" } } }]);
    expect(await new AgentSigner(account, true).sign(order, 0)).toEqual({ r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e", s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", v: 28 });
    expect(await new AgentSigner(account, false).sign(order, 0)).toEqual({ r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54", s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", v: 27 });
  });
  it("test_l1_action_signing_order_with_cloid_matches", async () => {
    const order = wire.order([{ asset: 1, isBuy: true, limitPx: "100", size: "100", reduceOnly: false, type: { limit: { tif: "Gtc" } }, cloid: "0x00000000000000000000000000000001" }]);
    expect(await new AgentSigner(account, true).sign(order, 0)).toEqual({ r: "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3", s: "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da", v: 27 });
    expect(await new AgentSigner(account, false).sign(order, 0)).toEqual({ r: "0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d", s: "0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988", v: 28 });
  });
  it("test_l1_action_signing_tpsl_order_matches", async () => {
    const order = wire.order([{ asset: 1, isBuy: true, limitPx: "100", size: "100", reduceOnly: false, type: { trigger: { isMarket: true, triggerPx: "103", tpsl: "sl" } } }]);
    expect(await new AgentSigner(account, true).sign(order, 0)).toEqual({ r: "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9", s: "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405", v: 27 });
    expect(await new AgentSigner(account, false).sign(order, 0)).toEqual({ r: "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4", s: "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac", v: 28 });
  });
  it("expiresAfter is part of the hash and the signature recovers to the agent", async () => {
    const order = wire.order([{ asset: 1, isBuy: true, limitPx: "100", size: "100", reduceOnly: false, type: { limit: { tif: "Ioc" } } }]);
    const h1 = actionHash(order, 5, {});
    const h2 = actionHash(order, 5, { expiresAfter: 1_790_000_000_000 });
    expect(h1).not.toBe(h2);
    const sig = await new AgentSigner(account, false).sign(order, 5, { expiresAfter: 1_790_000_000_000 });
    const recovered = await recoverTypedDataAddress({
      domain: EXCHANGE_DOMAIN,
      types: AGENT_TYPES,
      primaryType: "Agent",
      message: phantomAgent(h2, false),
      signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } as never,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});

describe("action allowlist (the agent can never withdraw)", () => {
  const forbidden = [
    // user-signed actions (HyperliquidSignTransaction domain): funds movement / permissions
    "withdraw3", "usdSend", "spotSend", "sendAsset", "usdClassTransfer", "approveAgent", "approveBuilderFee", "convertToMultiSigUser",
    "tokenDelegate", "cDeposit", "cWithdraw", "userSetAbstraction", "userDexAbstraction", "multiSig",
    // L1 actions that move value or change account structure
    "vaultTransfer", "subAccountTransfer", "subAccountSpotTransfer", "createSubAccount", "createVault", "vaultModify", "vaultDistribute",
    "agentSendAsset", "agentEnableDexAbstraction", "agentSetAbstraction", "setReferrer", "registerReferrer", "setDisplayName", "spotUser",
    "evmUserModify", "spotDeploy", "perpDeploy", "CSignerAction", "CValidatorAction", "linkStakingUser", "reserveRequestWeight", "noop",
    "twapOrder", "twapCancel", "gossipPriorityBid", "dummy", "", "ORDER", "Order", " order",
  ];
  it("refuses every non-allowlisted type before hashing", async () => {
    const signer = new AgentSigner(account, false);
    for (const type of forbidden) {
      expect(() => assertAllowedAction({ type })).toThrow(ForbiddenActionError);
      await expect(signer.sign({ type, destination: "0x0", amount: "1" }, 1)).rejects.toThrow(/not in the trading-only allowlist/);
    }
    expect(() => assertAllowedAction(null)).toThrow(ForbiddenActionError);
    expect(() => assertAllowedAction([])).toThrow(ForbiddenActionError);
    expect(() => assertAllowedAction({})).toThrow(ForbiddenActionError);
    expect(() => assertAllowedAction({ type: 1 })).toThrow(ForbiddenActionError);
  });
  it("refuses an allowlisted type smuggling user-signed fields", () => {
    for (const k of ["signatureChainId", "hyperliquidChain", "destination", "amount", "agentAddress", "builder"]) {
      expect(() => assertAllowedAction({ type: "order", [k]: "x" })).toThrow(ForbiddenActionError);
    }
  });
  it("accepts exactly the trading actions", () => {
    expect([...L1_ACTION_ALLOWLIST]).toEqual(["order", "cancel", "cancelByCloid", "modify", "batchModify", "updateLeverage", "updateIsolatedMargin", "scheduleCancel"]);
    for (const a of [
      wire.order([]),
      wire.cancel([{ asset: 1, oid: 2 }]),
      wire.cancelByCloid([{ asset: 1, cloid: "0x00000000000000000000000000000001" }]),
      wire.modify(1, { asset: 1, isBuy: true, limitPx: "1", size: "1", reduceOnly: false, type: { limit: { tif: "Gtc" } } }),
      wire.batchModify([]),
      wire.updateLeverage(1, false, 3),
      wire.updateIsolatedMargin(1, 1),
      wire.scheduleCancel(),
      wire.scheduleCancel(1),
    ]) {
      expect(() => assertAllowedAction(a)).not.toThrow();
    }
  });
  it("the signer module exposes no user-signed domain", async () => {
    const mod = await import("../src/hyperliquid/signer.js");
    const src = JSON.stringify(Object.keys(mod));
    expect(src).not.toMatch(/withdraw|usdSend|spotSend|approveAgent|HyperliquidSignTransaction/i);
    expect(mod.EXCHANGE_DOMAIN.name).toBe("Exchange");
    expect(mod.EXCHANGE_DOMAIN.chainId).toBe(1337);
  });
});

describe("wire formats and nonces", () => {
  it("orders keep the SDK key order and optional cloid", () => {
    expect(Object.keys(orderToWire({ asset: 1, isBuy: true, limitPx: "1", size: "2", reduceOnly: true, type: { limit: { tif: "Alo" } }, cloid: "0x00000000000000000000000000000001" as Hex }))).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
    expect(Object.keys(orderToWire({ asset: 1, isBuy: true, limitPx: "1", size: "2", reduceOnly: true, type: { limit: { tif: "Alo" } } }))).toEqual(["a", "b", "p", "s", "r", "t"]);
    expect(Object.keys(wire.updateLeverage(1, false, 3))).toEqual(["type", "asset", "isCross", "leverage"]);
    expect(Object.keys(wire.updateIsolatedMargin(1, 5))).toEqual(["type", "asset", "isBuy", "ntli"]);
    expect(wire.cancel([{ asset: 3, oid: 9 }])).toEqual({ type: "cancel", cancels: [{ a: 3, o: 9 }] });
  });
  it("nonces are strictly increasing even within the same millisecond", () => {
    let t = 1000;
    const n = new NonceSource(() => t);
    expect(n.next()).toBe(1000);
    expect(n.next()).toBe(1001);
    t = 1001;
    expect(n.next()).toBe(1002);
    t = 5000;
    expect(n.next()).toBe(5000);
  });
});
