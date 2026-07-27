export type ProviderReadinessCandidate = {
  id?: string;
  type?: string;
  available?: boolean;
  is_configured_instance?: boolean;
  has_api_key?: boolean;
  base_url?: string;
  is_default?: boolean;
  is_type_default?: boolean;
};

export function isConfiguredProviderInstance(
  provider: ProviderReadinessCandidate,
): boolean {
  if (provider.is_configured_instance !== undefined) {
    return provider.is_configured_instance;
  }

  return Boolean(
    provider.base_url
    || provider.has_api_key
    || provider.is_default
    || provider.is_type_default
    || (provider.id && provider.type && provider.id !== provider.type)
  );
}

export function isProviderConfigurationReady(
  modelsLoaded: boolean,
  providers: readonly ProviderReadinessCandidate[],
): boolean {
  if (modelsLoaded) {
    return true;
  }

  return providers.some(provider =>
    isConfiguredProviderInstance(provider) && provider.available === true
  );
}
