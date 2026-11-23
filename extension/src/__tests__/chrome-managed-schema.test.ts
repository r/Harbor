/**
 * Chrome only delivers an enterprise policy into `chrome.storage.managed`
 * if the extension's manifest declares `storage.managed_schema`
 * (https://developer.chrome.com/docs/extensions/reference/manifest/storage).
 * Firefox doesn't need this (policies.json "3rdparty" is enough), so this
 * checks the Chrome manifest and its schema file only — see HBR-163.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EXT_ROOT = join(__dirname, '..', '..');

type JsonSchemaLite = {
  type?: string;
  properties?: Record<string, JsonSchemaLite>;
  items?: JsonSchemaLite;
  additionalProperties?: boolean;
};

/**
 * Checks `value` against the restricted subset of JSON Schema that
 * Chrome's `storage.managed_schema` format supports (type, properties,
 * items, additionalProperties). A schema with no `type` is unconstrained
 * — Chrome's format has no "oneOf"/"anyOf", so that's how this schema
 * expresses "string or object" for the policy document's short-form rule
 * arrays.
 */
function conforms(value: unknown, schema: JsonSchemaLite): boolean {
  if (schema.type === undefined) return true;
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in (value as Record<string, unknown>)) {
            if (!conforms((value as Record<string, unknown>)[key], propSchema)) return false;
          }
        }
      }
      if (schema.additionalProperties === false && schema.properties) {
        const allowed = new Set(Object.keys(schema.properties));
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (!allowed.has(key)) return false;
        }
      }
      return true;
    }
    case 'array':
      if (!Array.isArray(value)) return false;
      if (schema.items) return value.every((item) => conforms(item, schema.items as JsonSchemaLite));
      return true;
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

describe('Chrome managed storage schema (HBR-163)', () => {
  it("declares storage.managed_schema in the Chrome manifest", () => {
    const manifest = JSON.parse(readFileSync(join(EXT_ROOT, 'manifest.chrome.json'), 'utf8'));
    expect(manifest.storage).toBeDefined();
    expect(manifest.storage.managed_schema).toBe('managed-schema.json');
    // The "storage" permission (needed for storage.managed at all) stays declared too.
    expect(manifest.permissions).toContain('storage');
  });

  it('the schema file named by the manifest exists and parses', () => {
    const manifest = JSON.parse(readFileSync(join(EXT_ROOT, 'manifest.chrome.json'), 'utf8'));
    const schemaPath = join(EXT_ROOT, manifest.storage.managed_schema);
    expect(existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.properties.policy).toBeDefined();
    expect(schema.properties.policy.type).toBe('object');
  });

  it("the policy property's schema accepts a PolicyDocument like docs/PERMISSIONS.md's example", () => {
    const schema = JSON.parse(readFileSync(join(EXT_ROOT, 'managed-schema.json'), 'utf8'));
    const policySchema = schema.properties.policy;

    // Mirrors the jsonc example under "The policy file" in docs/PERMISSIONS.md,
    // plus one of each of the other PolicyDocument fields (store.ts).
    const sampleDocument = {
      version: 2,
      title: 'Example org policy',
      rules: [
        {
          id: 'reader-default',
          effect: 'allow',
          principal: { origin: 'https://docs.example.com' },
          action: ['model.prompt.local', 'browser.read.activeTab'],
        },
        {
          id: 'block-labelled-egress',
          effect: 'deny',
          principal: { origin: '*' },
          action: { effect: 'egress' },
          context: { hasAnyLabel: ['credentials', 'payments', 'identity'] },
        },
      ],
      allow: ['Tool(github.*)', { id: 'typed-allow', effect: 'allow', principal: { origin: '*' }, action: 'tool.call' }],
      ask: ['Tool(*)'],
      deny: ['Egress(third_party)'],
      preview: [],
      pinnedManifests: [{ serverId: 'github', hash: 'sha256:abc123' }],
      trustedPublishers: [
        { name: 'acme', publicKey: 'base64key', algorithm: 'ed25519', allowedServerGlob: 'acme-*' },
      ],
    };

    expect(conforms(sampleDocument, policySchema)).toBe(true);

    // A document whose version isn't an integer should fail, so this check
    // isn't vacuously true.
    expect(conforms({ ...sampleDocument, version: '2' }, policySchema)).toBe(false);
  });
});
