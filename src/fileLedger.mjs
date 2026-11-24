// Node-only file ledger: JSONL, mode 600, one writer at a time (lock file holds the writer's pid).
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { seal, verifyChain } from './ledger.mjs';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

function lock(path) {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) throw new Error(`ledger ${path} is in use by pid ${pid}${pid === process.pid ? " (this process)" : ""}`);
      unlinkSync(lockPath); // stale lock from a dead process
    }
  }
  throw new Error(`could not lock ${path}`);
}

export function fileLedger(path, { readOnly = false } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const entries = [];
  if (existsSync(path)) {
    if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} is readable by others; chmod 600 it first`);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    lines.forEach((l, i) => {
      try { entries.push(JSON.parse(l)); } catch { throw new Error(`${path}:${i + 1}: not JSON; refusing to use a damaged ledger`); }
    });
    const bad = verifyChain(entries);
    if (bad !== -1) throw new Error(`${path}:${bad + 1}: entry altered or out of order; refusing to use a damaged ledger`);
  }
  const lockPath = readOnly ? null : lock(path);
  let closed = false;
  return {
    entries: () => entries,
    append(body) {
      if (readOnly || closed) throw new Error('ledger is read-only or closed');
      const e = seal(entries.at(-1), body);
      appendFileSync(path, JSON.stringify(e) + '\n', { mode: 0o600 });
      chmodSync(path, 0o600);
      entries.push(e);
      return e;
    },
    close() {
      if (lockPath && !closed) try { unlinkSync(lockPath); } catch { /* already gone */ }
      closed = true;
    },
  };
}
