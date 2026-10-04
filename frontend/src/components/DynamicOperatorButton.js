/**
 * "Continue with Dynamic" — auth via Dynamic (email/social/passkey) that provisions an
 * embedded wallet for the operator or underwriter role, then opens a local Avaira session.
 *
 * Deliberately additive: the existing Google/X flows keep working, and when the Dynamic
 * environment id is absent nothing renders.
 */
import { useCallback, useEffect, useState } from "react";
import { Wallet, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/App";
import { CHAIN_ID, isDynamicConfigured } from "@/lib/dynamicConfig";
import useDynamicOperator from "@/hooks/useDynamicOperator";

export default function DynamicOperatorButton({ onSignedIn }) {
  if (!isDynamicConfigured) return null;
  return <ButtonInner onSignedIn={onSignedIn} />;
}

function ButtonInner({ onSignedIn }) {
  const { setUser } = useAuth();
  const { ready, authenticated, address, isEmbedded, user, connect, status } = useDynamicOperator();
  const [handled, setHandled] = useState(false);

  /** Once Dynamic authenticates, open a local Avaira session for the embedded wallet. */
  const openSession = useCallback(async () => {
    if (!address || handled) return;
    setHandled(true);
    setUser({
      id: `dynamic:${address.toLowerCase()}`,
      email: user?.email ?? null,
      name: user?.alias ?? user?.username ?? null,
      wallet_address: address,
      wallet_kind: isEmbedded ? "dynamic-embedded" : "dynamic-external",
      auth_provider: "dynamic",
      chain_id: CHAIN_ID,
      is_admin: false,
    });
    toast.success(isEmbedded ? "Embedded wallet ready" : "Wallet connected");
    if (onSignedIn) onSignedIn();
  }, [address, handled, isEmbedded, onSignedIn, setUser, user]);

  useEffect(() => {
    if (authenticated) openSession();
  }, [authenticated, openSession]);

  return (
    <button
      type="button"
      data-testid="dynamic-login-btn"
      onClick={connect}
      disabled={!ready}
      className="w-full flex items-center justify-center gap-3 p-3 bg-gradient-to-r from-avaira-purple/20 to-avaira-data/10 border border-avaira-purple text-foreground font-heading font-semibold text-sm uppercase tracking-wider hover:border-avaira-data transition-colors disabled:opacity-50"
    >
      {ready ? <Wallet size={16} /> : <Loader2 size={16} className="animate-spin" />}
      {authenticated ? `Connected ${address?.slice(0, 6)}…${address?.slice(-4)}` : "Continue with Dynamic"}
      {isEmbedded ? <ShieldCheck size={14} className="text-avaira-green" /> : null}
      {status ? <span className="font-mono text-[9px] text-avaira-dim">{status}</span> : null}
    </button>
  );
}
