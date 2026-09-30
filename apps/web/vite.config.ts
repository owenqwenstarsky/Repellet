import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), '');
  const apiUrl = env.INTERNAL_APP_URL || 'http://127.0.0.1:3000';
  return {
    plugins: [react()],
    resolve: {
      alias: {
        'monaco-editor/esm/vs': fileURLToPath(
          new URL('../../node_modules/monaco-editor/esm/vs', import.meta.url),
        ),
      },
    },
    server: {
      port: 5173,
      proxy: { '/api': apiUrl, '/ws': { target: apiUrl.replace(/^http/, 'ws'), ws: true } },
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks: {
            editor: ['monaco-editor'],
            collaboration: ['yjs', 'y-monaco'],
            terminal: ['@xterm/xterm', '@xterm/addon-fit'],
          },
        },
      },
    },
  };
});
