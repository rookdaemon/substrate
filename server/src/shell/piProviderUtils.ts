/**
 * Shared utilities for Pi provider inference.
 *
 * Both createAgentLayer and ShellIndependenceService need to infer the
 * upstream provider from a model string (e.g. "openrouter/kimi-k2" → "openrouter").
 * Keeping this logic in one place avoids drift between the two call sites.
 */

/**
 * Infer the upstream API provider from the active Pi model string.
 *
 * The Pi CLI uses "provider/model" model-string notation. When a configured
 * provider is absent, the prefix before the first "/" is treated as the provider.
 * Returns undefined if the model string has no prefix or is not set.
 */
export function inferPiProvider(
  model: string | undefined,
  configuredProvider: string | undefined,
): string | undefined {
  if (configuredProvider) return configuredProvider;
  const providerPrefix = model?.split("/", 1)[0];
  return providerPrefix && providerPrefix !== model ? providerPrefix : undefined;
}
