// The trap catalog must match the shared Trap contract and cite real rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';
import { getRule, resolveRuleId, taxonomyVersion } from 'datapitfalls';

const require = createRequire(import.meta.url);
const trapSchema = require('@datapitfalls/schemas/schemas/trap.schema.json');
const catalog = yaml.load(readFileSync(new URL('../traps/catalog.yaml', import.meta.url), 'utf8'));
const validate = new Ajv2020({ allErrors: true }).compile(trapSchema);

test('the catalog is a non-empty list', () => {
  assert.ok(Array.isArray(catalog) && catalog.length > 0);
});

test('every trap matches the Trap schema', () => {
  for (const trap of catalog) {
    assert.ok(validate(trap), `${trap.id}: ${JSON.stringify(validate.errors)}`);
  }
});

test('trap ids are unique', () => {
  const ids = catalog.map((t) => t.id);
  assert.deepEqual(ids, [...new Set(ids)]);
});

test(`every pitfall id is a current rule id (taxonomy ${taxonomyVersion})`, () => {
  for (const trap of catalog) {
    for (const id of trap.pitfall_ids) {
      assert.ok(getRule(id), `${trap.id}: unknown rule id "${id}"`);
      assert.equal(resolveRuleId(id), id, `${trap.id}: "${id}" is an alias; use the current id`);
    }
  }
});

test('every data trap carries a read-only evidence query', () => {
  for (const trap of catalog.filter((t) => t.kind === 'data')) {
    assert.match(trap.evidence_query ?? '', /^\s*SELECT\b/i, `${trap.id}: missing evidence_query`);
    assert.doesNotMatch(
      trap.evidence_query,
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|PRAGMA)\b/i,
      `${trap.id}: evidence_query must only read`
    );
  }
});

test('an end month, when given, is not before the start month', () => {
  for (const trap of catalog) {
    if (trap.end_month) assert.ok(trap.end_month >= trap.start_month, trap.id);
  }
});
