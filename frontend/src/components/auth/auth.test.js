/**
 * Dynamic auth modal — smoke tests (configured state).
 *
 * House style: renderToStaticMarkup, matching design.smoke.test.js.
 * frontend/.env sets REACT_APP_DYNAMIC_ENV_ID, so in jest the modal
 * takes its live shape: social providers + email OTP. The fallback
 * card is covered in auth-unconfigured.test.js. SDK modules are
 * virtual-mocked (jest cannot resolve their subpath exports).
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
  useSignInWithSocialPopUp: () => ({ mutate: () => {}, isPending: false, error: null }),
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

const PROVIDERS = ["google", "apple", "discord", "github", "twitter"];

describe("the sign-in modal (configured)", () => {
  it("renders nothing when closed", () => {
    expect(chrome(false)).not.toContain("auth-modal");
  });

  it("offers every social provider above the email flow", () => {
    const html = chrome(true);
    expect(html).toContain('data-testid="auth-modal"');
    expect(html).toContain('data-testid="auth-social-row"');
    PROVIDERS.forEach((p) => {
      expect(html).toContain(`data-testid="auth-social-${p}"`);
    });
    expect(html).toContain("or with email");
    // the unconfigured card must NOT render
    expect(html).not.toContain("auth-unconfigured");
  });

  it("shows the email OTP form once configured", () => {
    const html = chrome(true);
    expect(html).toContain('id="auth-email"');
    expect(html).toContain('data-testid="auth-send-code"');
  });
});
