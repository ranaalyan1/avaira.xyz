/**
 * Light auth-UI context — zero SDK imports.
 *
 * Every page (including the marketing Landing, which is rendered in
 * jest smoke tests) can call useAuthUI() to open the sign-in modal or
 * read the current wallet identity. The heavy Dynamic SDK lives in
 * DynamicAuth.js / SignInModal.js and is only reachable through the
 * app root, never from a page import.
 */
import { createContext, useContext, useState, useCallback, useMemo, useRef } from "react";

const AuthUIContext = createContext({
  authOpen: false,
  openAuth: () => {},
  closeAuth: () => {},
  setDynamicAuth: () => {},
  dynamicUser: null,
  walletAddress: null,
  authConfigured: false,
  dynamicReady: true,
  registerDynamicLogout: () => {},
  callDynamicLogout: () => {},
});

export const useAuthUI = () => useContext(AuthUIContext);

export function AuthUIProvider({ children, initialOpen = false, initialDynamicReady }) {
  const [authOpen, setAuthOpen] = useState(initialOpen);
  const [dynamicUser, setDynamicUser] = useState(null);
  const [walletAddress, setWalletAddress] = useState(null);
  /* False while the SDK is restoring a stored session. ProtectedRoute waits
   * on this so a direct /dashboard load does not bounce through /login. */
  /* initialDynamicReady exists so tests can pin the restore state without
   * waiting for an effect that static rendering never runs. */
  const [dynamicReady, setDynamicReady] = useState(
    initialDynamicReady !== undefined
      ? initialDynamicReady
      : !Boolean(process.env.REACT_APP_DYNAMIC_ENV_ID),
  );
  /* LogoutBridge (inside the SDK providers) registers the real Dynamic
   * logout here; the app root calls it through callDynamicLogout(). */
  const dynamicLogoutRef = useRef(null);

  const openAuth = useCallback(() => setAuthOpen(true), []);
  const closeAuth = useCallback(() => setAuthOpen(false), []);

  /* written by DynamicScope (inside the providers at the app root),
     read by any page through this context */
  const setDynamicAuth = useCallback((user, addr, ready) => {
    setDynamicUser(user);
    setWalletAddress(addr);
    if (typeof ready === "boolean") setDynamicReady(ready);
  }, []);

  const registerDynamicLogout = useCallback((fn) => {
    dynamicLogoutRef.current = fn;
  }, []);

  const callDynamicLogout = useCallback(() => {
    if (dynamicLogoutRef.current) dynamicLogoutRef.current();
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
      dynamicReady,
      registerDynamicLogout,
      callDynamicLogout,
    }),
    [
      authOpen, openAuth, closeAuth, setDynamicAuth, dynamicUser, walletAddress,
      dynamicReady, registerDynamicLogout, callDynamicLogout,
    ],
  );

  return <AuthUIContext.Provider value={value}>{children}</AuthUIContext.Provider>;
}
