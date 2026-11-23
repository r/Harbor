/**
 * Chrome only delivers an enterprise policy into `chrome.storage.managed`
 * if the extension's manifest declares `storage.managed_schema`
 * (https://developer.chrome.com/docs/extensions/reference/manifest/storage),
 * and Chrome's schema format is restrictive: "Each schema must have
 * either a $ref value or exactly one type", `additionalProperties` must
 * itself be a schema (not a boolean) and isn't allowed at the root, and
 * there's no union type. A Harbor rule's `action` can be a string, an
 * array or an object, so no Chrome schema can describe a policy document
 * faithfully — Chrome instead gets `policy` as a JSON string, which
 * `loadManaged` in `extension/src/policy/store.ts` parses. Firefox's
 * `policies.json` delivers `policy` as an object directly and is
 * unaffected (it doesn't need a managed_schema at all). See HBR-163.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { Policy, type PolicyDocument } from '../policy/store';
import { getMockStorage, resetMockBrowser } from './test-setup';

const EXT_ROOT = join(__dirname, '..', '..');
const storage = getMockStorage();

beforeEach(() => {
  resetMockBrowser();
  Policy.__reset();
});

type SchemaNode = Record<string, unknown>;

/** Every object or array node under the schema root, including the root. */
function walk(node: SchemaNode, out: SchemaNode[] = []): SchemaNode[] {
  out.push(node);
  if (node.properties && typeof node.properties === 'object') {
    for (const child of Object.values(node.properties as Record<string, SchemaNode>)) {
      walk(child, out);
    }
  }
  if (node.items && typeof node.items === 'object') {
    walk(node.items as SchemaNode, out);
  }
  return out;
}

describe('Chrome managed storage schema (HBR-163)', () => {
  it('declares storage.managed_schema in the Chrome manifest', () => {
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
    JSON.parse(readFileSync(schemaPath, 'utf8'));
  });

  describe("conforms to Chrome's restricted schema format", () => {
    const schema = JSON.parse(readFileSync(join(EXT_ROOT, 'managed-schema.json'), 'utf8')) as SchemaNode;
    const nodes = walk(schema);

    it('every node has exactly one type, or a $ref, never both or neither', () => {
      for (const node of nodes) {
        const hasType = 'type' in node;
        const hasRef = '$ref' in node;
        expect(hasType || hasRef).toBe(true);
        expect(hasType && hasRef).toBe(false);
        if (hasType) expect(typeof node.type).toBe('string');
        if (hasRef) expect(typeof node.$ref).toBe('string');
      }
    });

    it('no node uses a boolean additionalProperties', () => {
      for (const node of nodes) {
        if ('additionalProperties' in node) {
          expect(typeof node.additionalProperties).not.toBe('boolean');
        }
      }
    });

    it('the root has no additionalProperties at all', () => {
      expect('additionalProperties' in schema).toBe(false);
    });

    it('declares `policy` as type string', () => {
      const policyNode = (schema.properties as Record<string, SchemaNode>).policy;
      expect(policyNode.type).toBe('string');
    });
  });

  it("loads a policy-file example like docs/PERMISSIONS.md's, delivered as a JSON string", async () => {
    // Mirrors the jsonc example under "The policy file" in docs/PERMISSIONS.md.
    const doc: PolicyDocument = {
      version: 2,
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
    };

    const asJsonString = JSON.stringify(doc);
    expect(typeof asJsonString).toBe('string');

    storage.managed.data['policy'] = asJsonString;
    await Policy.load();

    expect(Policy.state().managed).not.toBeNull();
    expect(Policy.rules().length).toBe(2);
    expect(Policy.rules().map((r) => r.id)).toEqual(['reader-default', 'block-labelled-egress']);
  });
});
