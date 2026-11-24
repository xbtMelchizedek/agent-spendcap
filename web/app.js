import { SpendCap } from './lib/spendcap.mjs';
import { parsePolicy } from './lib/policy.mjs';
import { memoryLedger, verifyChain } from './lib/ledger.mjs';
import { fromNano } from './lib/decimal.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const EXAMPLE = await (await fetch('examples/policy.json')).json();
const t0 = Date.now();
let offset = 0;
const now = () => t0 + offset;
let cap;

function apply(text) {
  try {
    const policy = parsePolicy(JSON.parse(text));
    cap = new SpendCap({ policy, ledger: memoryLedger(), now });
    $('policyMsg').innerHTML = '<span class="ok">Policy OK.</span> Ledger cleared.';
    $('result').textContent = '';
    $('verifyMsg').textContent = '';
    render();
  } catch (e) {
    $('policyMsg').innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  }
}

function show(r) {
  $('result').innerHTML = r.ok
    ? `<span class="ok">Held $${esc(r.reservedUsd)}</span> <code>${esc(r.id)}</code>`
    : `<span class="bad">Refused:</span> ${r.reasons.map(esc).join('; ')}`;
}

function render() {
  const s = cap.status();
  $('windows').innerHTML = s.windows.map((w) => {
    const pct = Math.min(100, (Number(w.usedUsd) / Number(w.maxUsd)) * 100);
    return `<div><strong>${esc(w.window)}</strong> <span class="muted">$${esc(w.usedUsd)} of $${esc(w.maxUsd)} used</span>
      <div class="bar${pct >= 99.99 ? ' full' : ''}"><span style="width:${pct}%"></span></div></div>`;
  }).join('');
  $('clock').textContent = `Simulated clock: +${Math.round(offset / 60000)} min · ${s.denied} refused · ${s.overruns} overruns`;
  $('holds').innerHTML = s.open.length
    ? `<table><thead><tr><th>Hold</th><th>Venue</th><th class="num">Held</th><th></th></tr></thead><tbody>${s.open.map((h) => `
      <tr><td><code>${esc(h.id.slice(0, 8))}</code>${h.expired ? ' <span class="badge">expired</span>' : ''}</td><td>${esc(h.venue)}</td><td class="num">$${esc(h.usd)}</td>
      <td><div class="row-actions"><button data-settle="${esc(h.id)}">Settle 60%</button><button class="secondary" data-over="${esc(h.id)}">Overrun</button><button class="secondary" data-release="${esc(h.id)}">Release</button></div></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">None.</p>';
  const e = cap.ledger.entries();
  $('ledger').innerHTML = `<table><thead><tr><th>#</th><th>Kind</th><th>Detail</th><th>Hash</th></tr></thead><tbody>${e.slice(-12).reverse().map((x) => `
    <tr><td class="num">${x.seq}</td><td>${esc(x.t)}</td><td>${esc(x.t === 'deny' ? x.reasons.join('; ') : x.nano ? '$' + fromNano(BigInt(x.nano)) + (x.venue ? ' · ' + x.venue : '') : (x.id ?? '').slice(0, 8))}</td><td><code>${esc(x.hash.slice(0, 16))}…</code></td></tr>`).join('')}</tbody></table>
    <p class="muted">${e.length} entries${e.length > 12 ? ', newest 12 shown' : ''}.</p>`;
}

$('holds').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  const id = b.dataset.settle ?? b.dataset.over ?? b.dataset.release;
  const h = cap.book().get(id);
  if (b.dataset.release) cap.release(id);
  else cap.settle(id, fromNano(b.dataset.over ? h.reserved + h.reserved / 5n : (h.reserved * 6n) / 10n));
  render();
});
$('auth').onclick = () => {
  try {
    show(cap.authorize({ venue: $('venue').value.trim(), model: $('model').value.trim(), usd: $('usd').value.trim(), privacy: $('privacy').value }));
  } catch (e) { $('result').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  render();
};
$('burst').onclick = () => {
  const venues = ['openrouter:pearl-research/fp8', 'venice', 'chutes-bittensor', 'shady-api'];
  let ok = 0, no = 0;
  for (let i = 0; i < 25; i++) {
    const r = cap.authorize({ venue: venues[i % 4], model: 'qwen/qwen3.8-27b', usd: (0.01 + (i % 5) * 0.01).toFixed(2), privacy: 'no-retention', purpose: 'runaway loop' });
    r.ok ? ok++ : no++;
  }
  $('result').innerHTML = `Runaway agent: <span class="ok">${ok} held</span>, <span class="bad">${no} refused</span>.`;
  render();
};
$('wait').onclick = () => { offset += 10 * 60_000; render(); };
$('tamper').onclick = () => {
  const e = cap.ledger.entries();
  if (!e.length) return;
  e[0].nano = '1';
  $('verifyMsg').innerHTML = '<span class="muted">Entry 0 now claims a different amount. Verify the chain.</span>';
  render();
};
$('verify').onclick = () => {
  const bad = verifyChain(cap.ledger.entries());
  $('verifyMsg').innerHTML = bad === -1 ? '<span class="ok">Chain intact.</span>' : `<span class="bad">Chain broken at entry ${bad}.</span>`;
};
$('reset').onclick = () => { $('policy').value = JSON.stringify(EXAMPLE, null, 2); apply($('policy').value); };
$('apply').onclick = () => { offset = 0; apply($('policy').value); };
$('reset').onclick();
