import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 後端 FastAPI 預設跑在 8000，前端以 /api 前綴代理過去，
    // 這樣前端程式碼不需要知道後端網址，部署時也不會有 CORS 問題。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
});
