/**
 * Dynamic auth modal — the fallback contract.
 *
 * When REACT_APP_DYNAMIC_ENV_ID is missing the whole flow collapses to a
 * clear "not configured" card: no social buttons, no email form. This pins
 * that graceful degradation so a missing env var can never ship a broken
 * sign-in. The dynamicClient module is mocked to that state directly.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("@dynamic-labs-sdk/client", () => ({ createDynamicClient: jest.fn() }), { virtual: true });
jest.mock("@dynamic-labs-sdk/evm", () => ({ addEvmExtension: jest.fn() }), { virtual: true });
jest.mock("@/dynamicClient", () => ({
  DYNAMIC_ENV_ID: "",
  dynamicAuthConfigured: false,
  default: null,
}));

import { AuthUIProvider } from "./AuthUIContext";
import SignInModal from "./SignInModal";

describe("the sign-in modal (unconfigured)", () => {
  it("explains what is missing instead of a dead flow", () => {
    const html = renderToStaticMarkup(
      <AuthUIProvider initialOpen={true}>
        <SignInModal />
      </AuthUIProvider>,
    );
    expect(html).toContain('data-testid="auth-modal"');
    expect(html).toContain('data-testid="auth-unconfigured"');
    expect(html).toContain("REACT_APP_DYNAMIC_ENV_ID");
    expect(html).not.toContain("auth-social-row");
    expect(html).not.toContain('id="auth-email"');
  });
});
