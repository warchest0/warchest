import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { robinhoodMainnet, robinhoodTestnet } from "./chains";
import { env } from "./env";

/**
 * Injected wallets only (EIP-6963 discovery lists every installed extension). WalletConnect can be added later
 * with a project id; it is left out to keep the static bundle lean. The configured chain comes first.
 */
const other = env.chain.id === robinhoodMainnet.id ? robinhoodTestnet : robinhoodMainnet;

export const wagmiConfig = createConfig({
  chains: [env.chain, other],
  connectors: [injected()],
  transports: {
    [robinhoodMainnet.id]: http(env.chain.id === robinhoodMainnet.id ? env.rpcUrl : undefined),
    [robinhoodTestnet.id]: http(env.chain.id === robinhoodTestnet.id ? env.rpcUrl : undefined),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
