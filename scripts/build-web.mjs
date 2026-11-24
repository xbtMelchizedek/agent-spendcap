// Assemble the static playground into _site/: web/, the library itself, vendored @noble/hashes (MIT), the example policy.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('_site', { recursive: true, force: true });
mkdirSync('_site/lib', { recursive: true });
cpSync('web', '_site', { recursive: true });
for (const f of ['decimal', 'policy', 'ledger', 'spendcap']) cpSync(`src/${f}.mjs`, `_site/lib/${f}.mjs`);
cpSync('examples', '_site/examples', { recursive: true });
cpSync('node_modules/@noble/hashes/esm', '_site/vendor/noble-hashes', { recursive: true, filter: (p) => !p.endsWith('.map') && !p.endsWith('.d.ts') });
cpSync('node_modules/@noble/hashes/LICENSE', '_site/vendor/noble-hashes/LICENSE');
console.log('built _site/');
