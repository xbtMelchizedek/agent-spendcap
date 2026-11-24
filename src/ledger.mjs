// Append-only, hash-chained ledger of every decision. The memory ledger runs anywhere (browser, tests); the file
// ledger keeps JSONL at mode 600 and takes a lock so two processes can't both spend the same budget.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const GENESIS = '0'.repeat(64);

export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

export const hashEntry = (e) => bytesToHex(sha256(utf8ToBytes(canonicalJson(e))));

/** Seal an entry onto the chain: adds seq, prev and hash. */
export function seal(prevEntry, body) {
  const e = { ...body, seq: prevEntry ? prevEntry.seq + 1 : 0, prev: prevEntry ? prevEntry.hash : GENESIS };
  return { ...e, hash: hashEntry(e) };
}

/** Index of the first broken entry, or -1 when the whole chain checks out. */
export function verifyChain(entries) {
  let prev = null;
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...rest } = entries[i];
    if (rest.seq !== i || rest.prev !== (prev ? prev.hash : GENESIS) || hash !== hashEntry(rest)) return i;
    prev = entries[i];
  }
  return -1;
}

export function memoryLedger(initial = []) {
  const entries = [...initial];
  if (verifyChain(entries) !== -1) throw new Error(`ledger: entry ${verifyChain(entries)} is altered or out of order`);
  return {
    entries: () => entries,
    append(body) {
      const e = seal(entries.at(-1), body);
      entries.push(e);
      return e;
    },
    close() {},
  };
}
