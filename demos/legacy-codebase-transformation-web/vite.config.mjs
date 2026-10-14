import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);
const serverDir = fileURLToPath(new URL('./server', import.meta.url));

export default defineConfig({
  plugins: [react(), {
    name: 'local-workflow-api',
    configureServer(server) {
      // Backend modules are CommonJS and cached; drop them and restart so API edits take effect.
      server.watcher.add(serverDir);
      server.watcher.on('change', (file) => {
        if (!path.resolve(file).startsWith(serverDir + path.sep)) return;
        for (const key of Object.keys(require.cache)) {
          if (key.startsWith(serverDir + path.sep)) delete require.cache[key];
        }
        server.restart();
      });
      server.middlewares.use(require('./server/api.js').createApiApp());
    }
  }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true }
});
