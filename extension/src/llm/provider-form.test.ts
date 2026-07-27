import { describe, expect, it } from 'vitest';

import { validateRemoteOllamaConfiguration } from './provider-form';

describe('validateRemoteOllamaConfiguration', () => {
  it('normalizes a remote HTTPS Ollama provider', () => {
    const result = validateRemoteOllamaConfiguration(
      '  Ollama (box)  ',
      '  https://ollama.keep.madeit.build/  ',
    );

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Ollama (box)',
        baseUrl: 'https://ollama.keep.madeit.build',
      },
    });
  });

  it('preserves an explicit Ollama port', () => {
    const result = validateRemoteOllamaConfiguration(
      'Homelab Ollama',
      'http://192.168.1.50:11434',
    );

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Homelab Ollama',
        baseUrl: 'http://192.168.1.50:11434',
      },
    });
  });

  it.each([
    ['', 'https://ollama.example.com', 'Enter a provider name'],
    ['Ollama', '', 'Enter an Ollama server URL'],
    ['Ollama', 'ollama.example.com', 'Enter a valid Ollama server URL'],
    ['Ollama', 'ftp://ollama.example.com', 'Ollama URLs must use HTTP or HTTPS'],
    ['Ollama', 'https://user:secret@ollama.example.com', 'Ollama URLs cannot contain credentials'],
    [
      'Ollama',
      'https://ollama.example.com/api',
      'Use the server origin without /api, query parameters, or fragments',
    ],
  ])('rejects invalid configuration', (name, baseUrl, expectedError) => {
    const result = validateRemoteOllamaConfiguration(name, baseUrl);

    expect(result).toEqual({ ok: false, error: expectedError });
  });
});
