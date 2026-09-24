import { register } from 'node:module';

// Resolve `cloudflare:workers` to the local shim so the ported Worker code loads
// unchanged under plain Node. Launch with:
//   node --import ./src/host/register.mjs ./src/host/main.mjs
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: new URL('./cloudflare-workers-shim.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

register(import.meta.url);
