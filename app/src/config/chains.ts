import { defineChain } from "viem";

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export const supportedChains = [robinhoodMainnet, robinhoodTestnet] as const;
export type SupportedChainId = (typeof supportedChains)[number]["id"];

export function chainById(id: number) {
  return supportedChains.find((c) => c.id === id) ?? robinhoodMainnet;
}

export function explorerTx(chainId: number, hash: string): string {
  return `${chainById(chainId).blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddress(chainId: number, address: string): string {
  return `${chainById(chainId).blockExplorers.default.url}/address/${address}`;
}
