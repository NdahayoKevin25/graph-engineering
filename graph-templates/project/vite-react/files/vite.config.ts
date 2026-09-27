import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: 'localhost', port: {{input.port}}, strictPort: true },
  preview: { host: 'localhost', port: {{input.port}}, strictPort: true },
});
