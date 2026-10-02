import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { MASTER_ENC_KEY: 'workers-runtime-test-master-key', ARC_RPC_URL: 'https://arc-rpc.test', KYBER_CLIENT_ID: 'radar-test', GOPLUS_APP_KEY: 'goplus-key', GOPLUS_APP_SECRET: 'goplus-secret' }
      }
    })
  ],
  test: {
    include: ['workers/**/*.runtime.mjs']
  }
});
