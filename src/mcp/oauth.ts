import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpOAuthConfig } from "../config/types.js";

type ConfigOAuthClientProviderOptions = {
  onChange?: (oauth: McpOAuthConfig) => void | Promise<void>;
};

const optionalString = (value: string | undefined): string | undefined =>
  value && value.length > 0 ? value : undefined;

export class ConfigOAuthClientProvider implements OAuthClientProvider {
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;

  constructor(
    private readonly store: McpOAuthConfig,
    private readonly metadata: OAuthClientMetadata,
    private readonly onRedirect: (url: URL) => void,
    private readonly redirect: string | URL | undefined = undefined,
    private readonly options: ConfigOAuthClientProviderOptions = {},
  ) {}

  get redirectUrl(): string | URL | undefined {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.metadata;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (!this.store.client_id) {
      return undefined;
    }

    return {
      client_id: this.store.client_id,
      client_secret: this.store.client_secret,
      client_id_issued_at: this.store.client_id_issued_at,
      client_secret_expires_at: this.store.client_secret_expires_at,
    };
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    this.store.client_id = clientInformation.client_id;
    this.store.client_secret = optionalString(clientInformation.client_secret);
    this.store.client_id_issued_at = clientInformation.client_id_issued_at;
    this.store.client_secret_expires_at = clientInformation.client_secret_expires_at;
    await this.options.onChange?.(this.store);
  }

  tokens(): OAuthTokens | undefined {
    if (!this.store.access_token || !this.store.token_type) {
      return undefined;
    }

    return {
      access_token: this.store.access_token,
      token_type: this.store.token_type,
      refresh_token: this.store.refresh_token,
      id_token: this.store.id_token,
      expires_in: this.store.expires_in,
      scope: this.store.scope,
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.store.access_token = tokens.access_token;
    this.store.token_type = tokens.token_type;
    this.store.refresh_token = optionalString(tokens.refresh_token);
    this.store.id_token = optionalString(tokens.id_token);
    this.store.expires_in = tokens.expires_in;
    this.store.scope = optionalString(tokens.scope);
    await this.options.onChange?.(this.store);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) {
      throw new Error("OAuth code verifier is missing");
    }

    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") {
      this.store.client_id = undefined;
      this.store.client_secret = undefined;
      this.store.client_id_issued_at = undefined;
      this.store.client_secret_expires_at = undefined;
    }

    if (scope === "all" || scope === "tokens") {
      this.store.access_token = undefined;
      this.store.token_type = undefined;
      this.store.refresh_token = undefined;
      this.store.id_token = undefined;
      this.store.expires_in = undefined;
      this.store.scope = undefined;
    }

    if (scope === "all" || scope === "verifier") {
      this.verifier = undefined;
    }

    if (scope === "all" || scope === "discovery") {
      this.discovery = undefined;
    }
  }
}

export const createOAuthMetadata = (serverName: string, redirectUrl: string): OAuthClientMetadata => ({
  client_name: `aimux ${serverName}`,
  redirect_uris: [redirectUrl],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});
