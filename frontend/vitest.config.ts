import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Kept separate from `vite.config.ts` so the app build never carries test
 * settings. `src/test/setup.ts` mocks the Tauri `invoke` and `listen` bridges,
 * which do not exist outside a Tauri window.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // The old feature components are being replaced in the next wave and do not
    // compile against the new stores; their (absent) tests are not our problem.
    exclude: ['node_modules/**', 'dist/**'],
    restoreMocks: true,
    clearMocks: true,
  },
});
