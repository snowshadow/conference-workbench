import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  // Open meeting pages may load a panel after a newer build has been published.
  build: { emptyOutDir: false },
  server: { port: 5187, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8797', '/ws': { target: 'ws://127.0.0.1:8797', ws: true } } },
});
