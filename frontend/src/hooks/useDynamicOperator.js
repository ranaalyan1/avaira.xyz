/**
 * Operator/underwriter wallet hook (Workstream 2).
 *
 * IMPORTANT: this hook must only be mounted underneath `DynamicContextProvider`
 * (`components/DynamicProvider.js` mounts it whenever `REACT_APP_DYNAMIC_ENV_ID` is set).
 * The two consumer components gate on `isDynamicConfigured` and render a fallback card
 * instead, so the rules of hooks are never bent and a build without credentials still works.
 *
 * It exposes the two Avaira actions that need an embedded wallet:
 *   • bindAgentWallet    — EIP-712 `AgentWalletSet` → `setAgentWallet`
 *   • depositCollateral  — approve + `depositCollateral`
 */
import { useCallback, useMemo, useState } from "react";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";

import {
  bindAgentWalletWithDynamic,
  depositCollateralWithDynamic,
  readCollateralPosition,
} from "@/lib/dynamicWallet";

export function useDynamicOperator() {
  const ctx = useDynamicContext();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const primaryWallet = ctx?.primaryWallet ?? null;
  const address = primaryWallet?.address ?? null;

  const isEmbedded = useMemo(() => {
    if (!primaryWallet) return false;
    if (typeof primaryWallet.isEmbeddedWallet === "boolean") return primaryWallet.isEmbeddedWallet;
    if (typeof primaryWallet.isEmbedded === "boolean") return primaryWallet.isEmbedded;
    const key = String(primaryWallet.connector?.key ?? primaryWallet.walletConnectorType ?? "");
    return /embedded|passkey|dynamic|email|sms/i.test(key);
  }, [primaryWallet]);

  const connect = useCallback(() => ctx?.setShowAuthFlow?.(true), [ctx]);

  const disconnect = useCallback(async () => {
    if (ctx?.handleLogout) await ctx.handleLogout();
  }, [ctx]);

  const bindAgentWallet = useCallback(
    async (agentId) => {
      setBusy(true);
      setError(null);
      try {
        const result = await bindAgentWalletWithDynamic({ primaryWallet, agentId, onStep: setStatus });
        setStatus(`bound ✓ ${result.txHash?.slice(0, 10)}…`);
        return result;
      } catch (err) {
        setError(err.shortMessage || err.message || String(err));
        setStatus(null);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [primaryWallet],
  );

  const depositCollateral = useCallback(
    async (agentId, amountUsdc) => {
      setBusy(true);
      setError(null);
      try {
        const result = await depositCollateralWithDynamic({
          primaryWallet,
          agentId,
          amountUsdc,
          onStep: setStatus,
        });
        setStatus("collateral deposited ✓");
        return result;
      } catch (err) {
        setError(err.shortMessage || err.message || String(err));
        setStatus(null);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [primaryWallet],
  );

  return {
    configured: true,
    ready: Boolean(ctx?.sdkHasLoaded),
    authenticated: Boolean(ctx?.isAuthenticated || address),
    primaryWallet,
    address,
    isEmbedded,
    user: ctx?.user ?? null,
    connect,
    disconnect,
    bindAgentWallet,
    depositCollateral,
    readCollateralPosition,
    status,
    busy,
    error,
  };
}

export default useDynamicOperator;
