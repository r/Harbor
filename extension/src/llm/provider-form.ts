export type RemoteOllamaConfiguration = {
  name: string;
  baseUrl: string;
};

export type RemoteOllamaValidationResult =
  | { ok: true; value: RemoteOllamaConfiguration }
  | { ok: false; error: string };

export function validateRemoteOllamaConfiguration(
  nameInput: string,
  baseUrlInput: string,
): RemoteOllamaValidationResult {
  const name = nameInput.trim();
  if (!name) {
    return { ok: false, error: 'Enter a provider name' };
  }

  const baseUrl = baseUrlInput.trim();
  if (!baseUrl) {
    return { ok: false, error: 'Enter an Ollama server URL' };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return { ok: false, error: 'Enter a valid Ollama server URL' };
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, error: 'Ollama URLs must use HTTP or HTTPS' };
  }

  if (parsedUrl.username || parsedUrl.password) {
    return { ok: false, error: 'Ollama URLs cannot contain credentials' };
  }

  if (parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
    return { ok: false, error: 'Use the server origin without /api, query parameters, or fragments' };
  }

  return {
    ok: true,
    value: {
      name,
      baseUrl: parsedUrl.origin,
    },
  };
}
