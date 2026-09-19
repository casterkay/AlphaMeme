import path from 'node:path';
import { atomicJson, readJsonWithBackup } from './store.mjs';

export function tokenKey(chain, address) {
  const value = String(address || '').trim();
  return `${chain}:${chain === 'sol' ? value : value.toLowerCase()}`;
}

export class RadarControls {
  constructor(dir, chains, initialChain) {
    this.file = path.join(dir, 'preferences.json');
    this.chains = chains;
    const defaults = { enabledChains: [initialChain], annotations: {} };
    this.value = { ...defaults, ...readJsonWithBackup(this.file, defaults).value };
    this.value.enabledChains = [...new Set(this.value.enabledChains)].filter(x => chains.includes(x)).slice(0, 3);
    if (!this.value.enabledChains.length) this.value.enabledChains = [initialChain];
  }

  setChains(chains) {
    if (!Array.isArray(chains) || !chains.length || chains.length > 3 || new Set(chains).size !== chains.length || chains.some(x => !this.chains.includes(x))) {
      throw Object.assign(new Error('invalid_selection'), { statusCode: 400 });
    }
    this.value.enabledChains = [...chains];
    atomicJson(this.file, this.value);
    return { enabledChains: this.value.enabledChains };
  }

  annotate({ chain, address, favorite, note }) {
    if (!this.chains.includes(chain) || typeof address !== 'string'
      || !(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(address)
      || typeof favorite !== 'boolean' || typeof note !== 'string' || note.length > 500) {
      throw Object.assign(new Error('invalid_annotation'), { statusCode: 400 });
    }
    const key = tokenKey(chain, address);
    if (favorite && !this.value.annotations[key]?.favorite && Object.values(this.value.annotations).filter(row => row.favorite).length >= 50) {
      throw Object.assign(new Error('favorite_limit'), { statusCode: 400 });
    }
    if (!this.value.annotations[key] && Object.keys(this.value.annotations).length >= 500) throw Object.assign(new Error('annotation_limit'), { statusCode: 400 });
    this.value.annotations[key] = { chain, address, favorite, note: note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''), updatedAt: Date.now() };
    if (!favorite && !note.trim()) delete this.value.annotations[key];
    atomicJson(this.file, this.value);
    return { saved: true };
  }
}
