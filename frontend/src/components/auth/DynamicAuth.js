/**
 * Dynamic auth layer — the SDK side.
 *
 * Mounted once at the app root, inside AuthUIProvider and
 * QueryClientProvider. When REACT_APP_DYNAMIC_ENV_ID is configured it
 * wraps children in <DynamicProvider>, bootstraps embedded wallets on
 * login, and mirrors live user/wallet state into the light context.
 * When unconfigured it renders children untouched, so the site (and
 * the sign-in modal's "not configured" state) keeps working.
 */
import { useEffect } from "react";
import {
  DynamicProvider,
  useUser,
  useGetWalletAccounts,
  useOnEvent,
} from "@dynamic-labs-sdk/react-hooks";
import {
  createWaasWalletAccounts,
  getChainsMissingWaasWalletAccounts,
} from "@dynamic-labs-sdk/client/waas";
import dynamicClient, { dynamicAuthConfigured } from "@/dynamicClient";

/* mirrors live Dynamic state into the light context */
function DynamicScope({ onState }) {
  const { data: user } = useUser();
  const { data: accounts = [] } = useGetWalletAccounts();

  useEffect(() => {
    onState(user || null, accounts[0]?.address || null);
  }, [user, accounts, onState]);

  return null;
}

/**
 * Creates embedded (WaaS) wallet accounts after login.
 * Called unconditionally on userChanged — the SDK can return a stale
 * non-zero account list immediately after auth, so we do not guard
 * on accounts.length === 0.
 */
export function WaasBootstrap() {
  useOnEvent({
    event: "userChanged",
    listener: async ({ user }) => {
      if (!user) return;
      const missing = getChainsMissingWaasWalletAccounts();
      if (missing.length > 0) {
        await createWaasWalletAccounts({ chains: missing });
      }
    },
  });
  return null;
}

export function DynamicAuthLayer({ onState, children }) {
  if (!dynamicAuthConfigured) return children || null;
  return (
    <DynamicProvider client={dynamicClient}>
      <WaasBootstrap />
      <DynamicScope onState={onState} />
      {children}
    </DynamicProvider>
  );
}
