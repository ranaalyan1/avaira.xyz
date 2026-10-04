/**
 * Dynamic SDK bootstrap (Workstream 2).
 *
 * Wraps the app in `DynamicContextProvider` only when `REACT_APP_DYNAMIC_ENV_ID` is set, so
 * a build without Dynamic credentials (CI, local demo, judges poking around) keeps working
 * exactly as before — the SDK is imported but never mounted.
 */
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";

import { CHAIN_ID, DYNAMIC_ENV_ID, isDynamicConfigured } from "@/lib/dynamicConfig";

export default function DynamicProvider({ children }) {
  if (!isDynamicConfigured) return children;

  const settings = {
    environmentId: DYNAMIC_ENV_ID,
    // Embedded wallets are provisioned for the operator / underwriter roles.
    initialAuthenticationMode: "connect-and-sign",
    enableConnectOnlyFallback: true,
    // Only the Avaira target chain is offered, so no accidental mainnet transactions.
    overrides: {
      evmNetworks: (networks = []) =>
        networks.map((network) => ({
          ...network,
          enabled: Number(network.chainId) === CHAIN_ID,
        })),
    },
    walletConnectProps: { appName: "Avaira Protocol" },
    modalProps: { theme: "dark" },
  };

  return (
    <DynamicContextProvider settings={settings} walletConnectors={[EthereumWalletConnectors]}>
      {children}
    </DynamicContextProvider>
  );
}

export { isDynamicConfigured, CHAIN_ID };
