import { isDemo } from "@/config/env";
import { demoProvider } from "./mock";
import { onchainProvider } from "./onchain";
import type { DataProvider } from "./types";

/** Demo mode is the default until governance and vault addresses are configured (see `config/env.ts`). */
export const provider: DataProvider = isDemo ? demoProvider : onchainProvider;
export { demoProvider, isDemo };
