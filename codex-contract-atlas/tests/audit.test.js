'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/audit_snapshot.js');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t, schema = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const document = {
    openapi: '3.1.0', info: { version: 'test' },
    paths: { '/responses': { post: { requestBody: { content: {
      'application/json': { schema: { $ref: '#/components/schemas/Input' } },
    } }, responses: { 200: { description: 'ok' } } } } },
    components: { schemas: { Input: schema } },
  };
  const bytes = JSON.stringify(document, null, 2);
  fs.writeFileSync(path.join(dir, 'openapi.json'), bytes);
  const commit = 'a'.repeat(40);
  const lock = { commits: { 'openai/openai-openapi': commit }, sources: [{
    sourceId: 'openapi', status: 'fetched', repo: 'openai/openai-openapi', commit,
    localPath: 'openapi.json', path: 'openapi.json', sha256: hash(bytes),
    url: `https://raw.githubusercontent.com/openai/openai-openapi/${commit}/openapi.json`,
    normalizedJson: { path: 'openapi.json', sha256: hash(bytes) },
  }] };
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(dir, 'mapping.json'), JSON.stringify({ entries: [{
    id: 'input', mapping: 'candidate', openai: {
      sourceId: 'openapi', pointer: '#/components/schemas/Input',
    }, codex: null,
  }] }));
  return { dir, lock };
}

function run(dir, out = 'out') {
  return spawnSync(process.execPath, [script, '--snapshot', dir, '--lock', path.join(dir, 'lock.json'),
    '--mapping', path.join(dir, 'mapping.json'), '--out', path.join(dir, out)], { encoding: 'utf8' });
}

test('CLI produces identical bytes on repeated regeneration', t => {
  const { dir } = fixture(t, { type: 'object', properties: { model: { type: 'string' } } });
  const first = run(dir);
  assert.equal(first.status, 0, first.stderr);
  const second = run(dir, 'again');
  assert.equal(second.status, 0, second.stderr);
  for (const name of fs.readdirSync(path.join(dir, 'out'))) {
    assert.deepEqual(fs.readFileSync(path.join(dir, 'out', name)), fs.readFileSync(path.join(dir, 'again', name)));
  }
});

test('graph retains cycles and conditional branches without expanding duplicates', t => {
  const { dir } = fixture(t, { oneOf: [
    { type: 'object', properties: { next: { $ref: '#/components/schemas/Input' } }, required: ['next'] },
    false,
  ], examples: [{ $ref: '#/not-a-schema-reference' }] });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'openapi-graph.json')));
  const root = graph.nodes.find(n => n.pointer === '#/components/schemas/Input');
  assert.equal(root.edges.filter(e => e.keyword === 'oneOf').length, 2);
  assert.ok(graph.nodes.some(n => n.schema === false));
  assert.equal(graph.nodes.filter(n => n.pointer === root.pointer).length, 1);
  assert.ok(graph.nodes.some(n => n.edges.some(e => e.keyword === '$ref' && e.target === root.pointer)));
  assert.equal(graph.issues.length, 0);
});

test('missing references make structural coverage incomplete', t => {
  const { dir } = fixture(t, { $ref: '#/components/schemas/Absent' });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'openapi-graph.json')));
  assert.equal(graph.meta.complete, false);
  assert.ok(graph.issues.some(i => i.reason === 'unresolved_reference'));
});

test('tampered source fails before generating a report', t => {
  const { dir } = fixture(t);
  fs.appendFileSync(path.join(dir, 'openapi.json'), ' ');
  const result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256/);
  assert.equal(fs.existsSync(path.join(dir, 'out', 'report.json')), false);
});

test('reference existence never upgrades semantic or backend evidence', t => {
  const { dir } = fixture(t);
  assert.equal(run(dir).status, 0);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'report.json')));
  assert.equal(report.mappings[0].openai.status, 'pointer_found');
  assert.equal(report.mappings[0].semanticStatus, 'NOT_REVALIDATED');
  assert.equal(report.mappings[0].backendStatus, 'NOT_RUN');
});

test('missing source and missing pointer remain distinct findings', t => {
  const { dir, lock } = fixture(t);
  lock.sources.push({ sourceId: 'compact', status: 'failed', reason: 'HTTP 404' });
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(lock));
  fs.writeFileSync(path.join(dir, 'mapping.json'), JSON.stringify({ entries: [{
    id: 'compact', mapping: 'candidate',
    openai: { sourceId: 'openapi', pointer: '#/missing' },
    codex: { sourceId: 'compact', symbol: 'CompactClient' },
  }] }));
  assert.equal(run(dir).status, 0);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'report.json')));
  assert.equal(report.mappings[0].openai.status, 'pointer_missing');
  assert.equal(report.mappings[0].codex.status, 'source_unavailable');
  assert.equal(report.sourceCoverage.failed, 1);
});

test('snapshot path traversal is rejected', t => {
  const { dir, lock } = fixture(t);
  lock.sources[0].localPath = '../outside.json';
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(lock));
  const result = run(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside snapshot/);
});

test('unknown schema keywords survive even when named like JavaScript prototypes', t => {
  const { dir } = fixture(t, JSON.parse('{"type":"object","__proto__":{"custom":true}}'));
  assert.equal(run(dir).status, 0);
  const graph = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'openapi-graph.json')));
  const schema = graph.nodes.find(n => n.pointer === '#/components/schemas/Input').schema;
  assert.equal(Object.hasOwn(schema, '__proto__'), true);
  assert.deepEqual(schema.__proto__, { custom: true });
});
