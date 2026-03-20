import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteApiBridgePlugin } from './vite-plugin-api-bridge-proxy';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        /** 端口被占用时直接失败并提示，避免静默换端口导致误以为「服务没起来」 */
        strictPort: true,
        /**
         * /api 由 viteApiBridgePlugin（enforce: 'pre'）用 Node http 直转 127.0.0.1:3003，
         * 不依赖内置 server.proxy，避免部分环境下代理未命中、/api 落静态层返回 HTML 404。
         */
      },
      preview: {
        host: '0.0.0.0',
        strictPort: true,
      },
      plugins: [viteApiBridgePlugin(), react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
