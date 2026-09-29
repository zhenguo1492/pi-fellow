import { defineConfig } from 'vitest/config';

/** Behavioural evals of the voice agent's prompt against a real omp process: `npm run eval:voice`. */
export default defineConfig({
    test: {
        include: ['src/test/eval/**/*.eval.ts'],
        testTimeout: 600_000,
        hookTimeout: 120_000,
        fileParallelism: false,
    },
});
