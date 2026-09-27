import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/test/unit/**/*.test.ts'],
        testTimeout: 120_000,
        hookTimeout: 60_000,
    },
});
