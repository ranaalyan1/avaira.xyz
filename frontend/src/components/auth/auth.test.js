/**
 * Dynamic auth modal — smoke tests.
 *
 * House style: renderToStaticMarkup, matching design.smoke.test.js.
 * The SDK modules are virtual-mocked (jest cannot resolve their
 * subpath exports); these tests pin our UI contract: closed by
 * default, the unconfigured fallback state, and the testids the
 * chrome tests rely on.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("@dynamic-labs-sdk/client", () => ({ createDynamicClient: jest.fn() }), { virtual: true });
jest.mock("@dynamic-labs-sdk/evm", () => ({ addEvmExtension: jest.fn() }), { virtual: true });
jest.mock("@dynamic-labs-sdk/react-hooks", () => ({
  DynamicProvider: ({ children }) => children,
  useUser: () => ({ data: null }),
  useGetWalletAccounts: () => ({ data: [] }),
  useOnEvent: () => {},
  useSendEmailOTP: () => ({ mutate: () => {}, data: undefined, isPending: false, error: null }),
  useVerifyOTP: () => ({ mutate: () => {}, isPending: false, error: null }),
  useLogout: () => ({ mutate: () => {} }),
}), { virtual: true });
jest.mock("@dynamic-labs-sdk/client/waas", () => ({
  createWaasWalletAccounts: jest.fn(),
  getChainsMissingWaasWalletAccounts: () => [],
}), { virtual: true });

import { AuthUIProvider } from "./AuthUIContext";
import SignInModal from "./SignInModal";

function chrome(initialOpen) {
  return renderToStaticMarkup(
    <AuthUIProvider initialOpen={initialOpen}>
      <SignInModal />
    </AuthUIProvider>,
  );
}

describe("the sign-in modal", () => {
  it("renders nothing when closed", () => {
    expect(chrome(false)).not.toContain("auth-modal");
  });

  it("shows the unconfigured state when no environment ID is set", () => {
    const html = chrome(true);
    expect(html).toContain('data-testid="auth-modal"');
    expect(html).toContain('data-testid="auth-unconfigured"');
    expect(html).toContain("REACT_APP_DYNAMIC_ENV_ID");
    expect(html).toContain("Dynamic console");
  });

  it("keeps the flow inaccessible until the environment ID exists", () => {
    // without configuration the OTP form must NOT render (no email input)
    const html = chrome(true);
    expect(html).not.toContain('id="auth-email"');
    expect(html).not.toContain('id="auth-code"');
  });
});
