/**
 * Dynamic.xyz client — module-level singleton.
 *
 * The client is created once at import time, extensions are registered
 * immediately, and the whole app imports this module at the root so
 * registration happens before any component renders.
 *
 * The environment ID comes from REACT_APP_DYNAMIC_ENV_ID. When it is absent
 * (local dev without secrets, CI, test runs) the whole Dynamic layer is
 * bypassed: no client is created, the sign-in modal explains what is missing,
 * and everything else on the site keeps working.
 */
import { createDynamicClient } from "@dynamic-labs-sdk/client";
import { addEvmExtension } from "@dynamic-labs-sdk/evm";

export const DYNAMIC_ENV_ID = process.env.REACT_APP_DYNAMIC_ENV_ID || "";
export const dynamicAuthConfigured = Boolean(DYNAMIC_ENV_ID);

let client = null;

if (dynamicAuthConfigured) {
  client = createDynamicClient({
    environmentId: DYNAMIC_ENV_ID,
    metadata: {
      name: "Avaira",
      universalLink: window.location.origin,
    },
  });
  // Register extensions immediately after createDynamicClient().
  addEvmExtension();
}

export default client;
