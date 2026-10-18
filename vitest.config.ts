import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Simulated measurements run a full sweep and analysis; CI machines are slower.
    testTimeout: 60000,
  },
});
