import { defineConfig } from 'vite';

// 서브경로(/<repo>/) 호스팅용. 라이브 URL:
//   https://sigco3111.github.io/luminous-lake/
export default defineConfig({
  base: '/luminous-lake/',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2400
  },
  server: {
    host: '0.0.0.0',
    port: 4181
  }
});
