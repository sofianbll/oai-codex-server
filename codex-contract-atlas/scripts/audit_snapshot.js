#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../src/schema.js');
const { schemaGraph } = require('./schema_graph.js');
const root = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(bytes.toString('utf8'));

function checkedFile(directory, relative, expected) {
  const file = path.resolve(directory, relative);
  if (!file.startsWith(directory + path.sep)) throw new Error('Path outside snapshot: ' + relative);
  const real = fs.realpathSync(file);
  if (!real.startsWith(fs.realpathSync(directory) + path.sep)) throw new Error('Symlink outside snapshot: ' + relative);
  const bytes = fs.readFileSync(file);
  if (!/^[a-f0-9]{64}$/.test(expected) || digest(bytes) !== expected) throw new Error('SHA-256 mismatch: ' + relative);
  return bytes;
}

function references(side, sources, document) {
  if (!side) return { status: 'no_mapping_claimed' };
  const source = sources.get(side.sourceId);
  const base = { sourceId: side.sourceId, pointer: side.pointer || null, symbol: side.symbol || null };
  if (!source || source.status !== 'fetched') return { ...base, status: 'source_unavailable' };
  const evidence = { ...base, commit: source.commit, sha256: source.sha256, url: source.url };
  if (side.sourceId === 'openapi' && side.pointer) {
    try { S.get(document, side.pointer); return { ...evidence, status: 'pointer_found' }; }
    catch (error) { return { ...evidence, status: 'pointer_missing', detail: error.message }; }
  }
  if (side.symbol && /^[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)*$/.test(side.symbol)) {
    const lines = source.text.split('\n');
    const tokens = side.symbol.split(/::|\./);
    const locations = tokens.map(token => ({ token, line: lines.findIndex(line => new RegExp('\\b' + token + '\\b').test(line)) + 1 }));
    return { ...evidence, status: locations.every(x => x.line > 0) ? 'text_candidate' : 'symbol_not_located', locations,
      note: 'Lexical occurrence only; scope, serde behavior and semantic equivalence require manual verification.' };
  }
  return { ...evidence, status: 'manual_locator' };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/audit_snapshot.js [--snapshot snapshot] [--lock research/source-lock.json] [--mapping data/mapping.json] [--out research/generated]');
    return;
  }
  const options = { '--snapshot': path.join(root, 'snapshot'), '--lock': path.join(root, 'research/source-lock.json'),
    '--mapping': path.join(root, 'data/mapping.json'), '--out': path.join(root, 'research/generated') };
  for (let index = 0; index < args.length; index += 2) {
    if (!Object.hasOwn(options, args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Unknown option or missing value: ' + args[index]);
    options[args[index]] = path.resolve(args[index + 1]);
  }
  const lockBytes = fs.readFileSync(options['--lock']);
  const mappingBytes = fs.readFileSync(options['--mapping']);
  const lock = json(lockBytes), mapping = json(mappingBytes);
  const sources = new Map();
  for (const source of lock.sources) {
    if (sources.has(source.sourceId)) throw new Error('Duplicate source ID: ' + source.sourceId);
    if (source.status !== 'fetched') { sources.set(source.sourceId, source); continue; }
    if (!/^[a-f0-9]{40}$/.test(source.commit) || lock.commits[source.repo] !== source.commit) throw new Error('Invalid commit: ' + source.sourceId);
    const expectedUrl = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${source.path.split('/').map(encodeURIComponent).join('/')}`;
    if (source.url !== expectedUrl) throw new Error('Unpinned source URL: ' + source.sourceId);
    const bytes = checkedFile(options['--snapshot'], source.localPath, source.sha256);
    sources.set(source.sourceId, { ...source, text: bytes.toString('utf8') });
  }
  const openapi = sources.get('openapi');
  if (!openapi || openapi.status !== 'fetched' || !openapi.normalizedJson) throw new Error('Pinned OpenAPI JSON is required.');
  const normalized = checkedFile(options['--snapshot'], openapi.normalizedJson.path, openapi.normalizedJson.sha256);
  const document = json(normalized);
  const graph = schemaGraph(document);
  const mappings = mapping.entries.map(entry => ({
    id: entry.id, category: entry.category, family: entry.family,
    editorialClassification: entry.mapping, semanticStatus: 'NOT_REVALIDATED', backendStatus: 'NOT_RUN',
    openai: references(entry.openai, sources, document), codex: references(entry.codex, sources, document),
  }));
  const referenceCounts = {};
  for (const entry of mappings) for (const side of ['openai', 'codex']) {
    const status = entry[side].status;
    referenceCounts[status] = (referenceCounts[status] || 0) + 1;
  }
  const sourceCoverage = { total: lock.sources.length, fetched: 0, failed: 0, not_fetched: 0 };
  for (const source of lock.sources) {
    if (!['fetched', 'failed', 'not_fetched'].includes(source.status)) throw new Error('Invalid source status: ' + source.sourceId);
    sourceCoverage[source.status]++;
  }
  const report = {
    version: 1, commits: lock.commits, sourceCoverage, inventory: graph.meta,
    inputHashes: { sourceLock: digest(lockBytes), mapping: digest(mappingBytes), openapi: digest(normalized) },
    generatorHashes: Object.fromEntries(['scripts/audit_snapshot.js', 'scripts/schema_graph.js', 'src/schema.js'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))])),
    mappingCount: mappings.length, referenceCounts, semanticMappingsRevalidated: 0, backendCalls: 0,
    limitations: ['A successful audit means reproducible evidence generation, not full compatibility.',
      'Unavailable sources and unresolved pointers remain findings; tampered files stop generation.',
      'Lexical Codex matches are search aids, not a Rust type/serde extraction.',
      'Original editorial mappings are preserved and are not automatically revalidated.'],
    mappings,
  };
  const unknowns = {
    sourceFindings: lock.sources.filter(s => s.status !== 'fetched'),
    schemaFindings: graph.issues,
    referenceFindings: mappings.flatMap(m => ['openai', 'codex'].filter(side => !['pointer_found', 'no_mapping_claimed'].includes(m[side].status)).map(side => ({ id: m.id, side, ...m[side] }))),
    experiments: mapping.experiments || [],
    next: 'Manually revalidate semantics against pinned sources, beginning with Responses Core; backend tests remain NOT_RUN.',
  };
  fs.mkdirSync(options['--out'], { recursive: true });
  for (const [name, data] of Object.entries({ 'openapi-graph.json': graph, 'report.json': report, 'unknowns.json': unknowns })) {
    fs.writeFileSync(path.join(options['--out'], name), JSON.stringify(data, null, 2) + '\n');
  }
  const summary = `# Atlas — contrôle reproductible\n\n` +
    Object.entries(lock.commits).map(([repo, sha]) => `- ${repo} : \`${sha}\``).join('\n') +
    `\n\n${sourceCoverage.fetched}/${sourceCoverage.total} sources collectées et empreintes vérifiées ; ${sourceCoverage.failed} absente(s), ${sourceCoverage.not_fetched} non figée(s).\n\n` +
    `${graph.meta.operationCount} opérations ; ${graph.meta.schemaNodes} nœuds de schéma uniques ; ${graph.meta.propertyDeclarations} déclarations de propriétés. ${graph.issues.length} problème(s) de parcours.\n\n` +
    `Les nombres décrivent des déclarations, pas des fonctionnalités ni un taux de compatibilité. Le parcours conserve les références, compositions et contraintes.\n\n` +
    `## Contrôle des ${mappings.length} fiches éditoriales\n\n| Résultat de localisation | Nombre de côtés de fiche |\n|---|---:|\n` +
    Object.entries(referenceCounts).map(([status, count]) => `| ${status} | ${count} |`).join('\n') +
    `\n\nUn pointeur trouvé prouve son existence. Une occurrence textuelle Codex aide à localiser le code ; elle ne valide pas le symbole, sa sérialisation ou l'équivalence. **0 mapping sémantique revalidé, 0 appel backend.**\n\n` +
    `Les sources absentes, références à revoir et expériences sont dans [unknowns.json](unknowns.json). Les preuves par fiche sont dans [report.json](report.json).\n\n` +
    `Régénération hors ligne : \`npm run audit\`. Les sorties ne contiennent ni date d'exécution ni chemin absolu. Les empreintes des entrées et générateurs sont dans le rapport.\n`;
  fs.writeFileSync(path.join(options['--out'], 'REPORT.md'), summary);
  console.log(JSON.stringify({ sources: sourceCoverage, inventory: graph.meta, mappingCount: mappings.length, referenceCounts }, null, 2));
}
try { main(); }
catch (error) { console.error('Audit failed:', error.message); process.exitCode = 1; }
