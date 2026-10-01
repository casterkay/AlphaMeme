import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { MASTER_ENC_KEY: 'workers-runtime-test-master-key', ALCHEMY_API_KEY: 'workers-runtime-test-alchemy-key' }
      }
    })
  ],
  test: {
    include: ['workers/**/*.runtime.mjs']
  }
});
