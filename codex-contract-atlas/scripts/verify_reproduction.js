#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-reproduction-'));
try {
  const snapshots = process.argv.slice(2);
  if (snapshots.length > 1) throw new Error('Usage: node scripts/verify_reproduction.js [snapshot-directory]');
  const options = snapshots.length ? ['--snapshot', path.resolve(snapshots[0])] : [];
  const directories = [path.join(temporary, 'first'), path.join(temporary, 'second')];
  for (const directory of directories) execFileSync(process.execPath, [path.join(__dirname, 'audit_snapshot.js'), ...options, '--out', directory], { stdio: 'pipe' });
  const artifacts = fs.readdirSync(directories[0]).sort().map(name => {
    const bytes = fs.readFileSync(path.join(directories[0], name));
    if (!bytes.equals(fs.readFileSync(path.join(directories[1], name)))) throw new Error('Non-deterministic artifact: ' + name);
    return { path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  const target = path.join(root, 'research/generated');
  fs.mkdirSync(target, { recursive: true });
  for (const artifact of artifacts) fs.copyFileSync(path.join(directories[0], artifact.path), path.join(target, artifact.path));
  fs.writeFileSync(path.join(root, 'research/reproduction-check.json'), JSON.stringify({
    status: 'PASS', generationsCompared: 2, comparison: 'byte-for-byte', artifacts,
    backendCalls: 0, semanticCompatibilityValidated: false,
  }, null, 2) + '\n');
  console.log(`PASS: ${artifacts.length} artifacts identical across two offline generations.`);
} catch (error) {
  console.error(error.stderr?.toString() || error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
