/**
 * Light auth-UI context — zero SDK imports.
 *
 * Every page (including the marketing Landing, which is rendered in
 * jest smoke tests) can call useAuthUI() to open the sign-in modal or
 * read the current wallet identity. The heavy Dynamic SDK lives in
 * DynamicAuth.js / SignInModal.js and is only reachable through the
 * app root, never from a page import.
 */
import { createContext, useContext, useState, useCallback, useMemo } from "react";

const AuthUIContext = createContext({
  authOpen: false,
  openAuth: () => {},
  closeAuth: () => {},
  setDynamicAuth: () => {},
  dynamicUser: null,
  walletAddress: null,
  authConfigured: false,
});

export const useAuthUI = () => useContext(AuthUIContext);

export function AuthUIProvider({ children, initialOpen = false }) {
  const [authOpen, setAuthOpen] = useState(initialOpen);
  const [dynamicUser, setDynamicUser] = useState(null);
  const [walletAddress, setWalletAddress] = useState(null);

  const openAuth = useCallback(() => setAuthOpen(true), []);
  const closeAuth = useCallback(() => setAuthOpen(false), []);

  /* written by DynamicScope (inside the providers at the app root),
     read by any page through this context */
  const setDynamicAuth = useCallback((user, addr) => {
    setDynamicUser(user);
    setWalletAddress(addr);
  }, []);

  const value = useMemo(
    () => ({
      authOpen,
      openAuth,
      closeAuth,
      setDynamicAuth,
      dynamicUser,
      walletAddress,
      /* configured = a Dynamic environment ID exists. Served as context so
         pages never import the SDK module directly. */
      authConfigured: Boolean(process.env.REACT_APP_DYNAMIC_ENV_ID),
    }),
    [authOpen, openAuth, closeAuth, setDynamicAuth, dynamicUser, walletAddress],
  );

  return <AuthUIContext.Provider value={value}>{children}</AuthUIContext.Provider>;
}
