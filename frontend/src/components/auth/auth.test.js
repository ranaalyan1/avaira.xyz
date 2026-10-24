/**
 * Dynamic auth modal — smoke tests (configured state).
 *
 * House style: renderToStaticMarkup, matching design.smoke.test.js.
 * The configuration is mocked explicitly (see the `@/dynamicClient` mock
 * below) rather than read from an untracked frontend/.env: a clean checkout
 * has no .env, and this file must not depend on one to reach the configured
 * shape. The fallback card is covered in auth-unconfigured.test.js. SDK
 * modules are virtual-mocked (jest cannot resolve their subpath exports).
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
/* Configured deployment. Env vars in this repo are not committed, so the state
 * has to be stated by the test instead of inherited from `.env`. */
jest.mock("@/dynamicClient", () => ({
  DYNAMIC_ENV_ID: "test-environment-id",
  dynamicAuthConfigured: true,
  default: {},
}));

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
