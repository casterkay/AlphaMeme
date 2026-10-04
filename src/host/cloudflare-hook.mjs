import { registerHooks } from 'node:module';

// The Durable Object classes import `cloudflare:workers` while both hosts
// coexist; under Node that import resolves to a plain base class. Import this
// module before any module that imports those classes.
const standIn = new URL('./durable-object.mjs', import.meta.url).href;

registerHooks({
  resolve: (specifier, context, nextResolve) => specifier === 'cloudflare:workers'
    ? { url: standIn, shortCircuit: true }
    : nextResolve(specifier, context)
});
