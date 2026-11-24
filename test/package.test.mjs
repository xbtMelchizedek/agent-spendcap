import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package: bin, exports and files resolve; version matches the changelog', async () => {
  assert.ok(existsSync(new URL(`../${pkg.bin['agent-spendcap']}`, import.meta.url)));
  assert.match(readFileSync(new URL(`../${pkg.bin['agent-spendcap']}`, import.meta.url), 'utf8'), /^#!\/usr\/bin\/env node/);
  const lib = await import('agent-spendcap');
  for (const k of ['SpendCap', 'parsePolicy', 'memoryLedger', 'verifyChain', 'toNano', 'fromNano']) assert.equal(typeof lib[k], 'function', k);
  assert.equal(typeof (await import('agent-spendcap/file')).fileLedger, 'function');
  assert.equal(typeof (await import('agent-spendcap/openai')).spendcapFetch, 'function');
  for (const f of pkg.files) assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f);
  assert.match(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), new RegExp(`## ${pkg.version.replaceAll('.', '\\.')} `));
});
