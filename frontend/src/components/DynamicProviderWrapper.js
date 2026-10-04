import React, { createContext, useContext, useEffect, useMemo } from "react";
import { DynamicContextProvider, useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";

import { MONAD_TESTNET } from "@/lib/web3";
import { useAuth } from "@/App";

/**
 * Dynamic (docs.dynamic.xyz) integration — Workstream 2.
 *
 * When REACT_APP_DYNAMIC_ENV_ID is set, the app is wrapped in Dynamic's context:
 * users authenticate through Dynamic (email/social/passkey), an embedded wallet is
 * provisioned for them, and that wallet signs the EIP-712 agentWallet binding and
 * the underwriter collateral flows — no MetaMask required.
 *
 * When the env id is absent everything degrades gracefully to the pre-Dynamic app.
 */

export const DYNAMIC_ENV_ID = process.env.REACT_APP_DYNAMIC_ENV_ID || "";
export const isDynamicConfigured = () => DYNAMIC_ENV_ID.length > 0;

const DynamicSessionContext = createContext(null);

/**
 * Session view of the Dynamic integration. `null` when Dynamic is not configured;
 * otherwise { configured, ready, user, primaryWallet, userWallets, openAuthFlow, logoutDynamic }.
 */
export const useDynamicSession = () => useContext(DynamicSessionContext);

const dynamicSettings = {
  environmentId: DYNAMIC_ENV_ID,
  walletConnectors: EthereumWalletConnectors(),
  // Teach Dynamic about Monad Testnet so embedded wallets can target chain 10143.
  networkConfigurations: {
    EVM: {
      [MONAD_TESTNET.id]: {
        chainId: MONAD_TESTNET.id,
        chainName: MONAD_TESTNET.name,
        nativeCurrency: MONAD_TESTNET.nativeCurrency,
        rpcUrls: [MONAD_TESTNET.rpcUrls.default.http[0]],
        blockExplorerUrls: [MONAD_TESTNET.blockExplorers.default.url],
      },
    },
  },
  // Embedded-first experience: auth flows stay inline instead of a redirect.
  authentication: { requireSession: true },
};

/** Bridges Dynamic auth state into the app's AuthContext. */
function DynamicSync({ children }) {
  const dynamic = useDynamicContext();
  const { user: appUser, setUser } = useAuth();
  const { user: dynUser, sdkHasLoaded } = dynamic;

  useEffect(() => {
    if (!sdkHasLoaded) return;
    // A Dynamic-authenticated user gets an app session even without backend OAuth.
    // An existing backend session (Google/X) is left untouched.
    if (!appUser && dynUser) {
      setUser({
        source: "dynamic",
        id: dynUser.userId,
        email: dynUser.email ?? null,
        username: dynUser.username ?? dynUser.email ?? "dynamic-user",
        is_dynamic: true,
      });
    }
  }, [sdkHasLoaded, dynUser, appUser, setUser]);

  const { primaryWallet, setShowAuthFlow, handleLogOut } = dynamic;
  const value = useMemo(
    () => ({
      configured: true,
      ready: sdkHasLoaded,
      user: dynUser,
      primaryWallet: primaryWallet ?? null,
      openAuthFlow: () => setShowAuthFlow(true),
      logoutDynamic: handleLogOut,
    }),
    [sdkHasLoaded, dynUser, primaryWallet, setShowAuthFlow, handleLogOut],
  );

  return <DynamicSessionContext.Provider value={value}>{children}</DynamicSessionContext.Provider>;
}

/** Keeps a misconfigured Dynamic environment from taking the whole dashboard down. */
class DynamicErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error("[dynamic] provider failed to initialise:", error);
  }
  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

export default function DynamicProviderWrapper({ children }) {
  if (!isDynamicConfigured()) return children;
  return (
    <DynamicErrorBoundary fallback={children}>
      <DynamicContextProvider settings={dynamicSettings}>
        <DynamicSync>{children}</DynamicSync>
      </DynamicContextProvider>
    </DynamicErrorBoundary>
  );
}
