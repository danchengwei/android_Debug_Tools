/**
 * 在 Vite 中间件链最前将 /api 转发到本机 adb-server。
 * 解决内置 server.proxy 在部分环境下未命中、请求落到 SPA/静态层返回 HTML 404 的问题（H5 面板报「像普通网页而不是调试接口」）。
 */
import http from 'node:http';
import type { Connect, Plugin } from 'vite';

const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 3003;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

function forwardHeaders(
  headers: http.IncomingHttpHeaders
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k || HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out.host = `${BRIDGE_HOST}:${BRIDGE_PORT}`;
  return out;
}

export function createApiBridgeProxyMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api')) {
      next();
      return;
    }

    const opt: http.RequestOptions = {
      hostname: BRIDGE_HOST,
      port: BRIDGE_PORT,
      path: url,
      method: req.method ?? 'GET',
      headers: forwardHeaders(req.headers),
    };

    const upstream = http.request(opt, (upRes) => {
      res.statusCode = upRes.statusCode ?? 502;
      for (const [key, val] of Object.entries(upRes.headers)) {
        if (val === undefined) continue;
        if (key.toLowerCase() === 'transfer-encoding') continue;
        res.setHeader(key, val);
      }
      upRes.pipe(res);
    });

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      console.error('[vite-api-bridge]', err.message);
      if (res.writableEnded) return;
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(
          JSON.stringify({
            ok: false,
            reason: 'bridge_unreachable',
            message: `本机 adb-server 未监听 ${BRIDGE_HOST}:${BRIDGE_PORT}（${err.message}）。请用「启动调试工具」完整启动，勿单独只开前端。`,
          })
        );
      }
    });

    req.pipe(upstream);
  };
}

/** Vite 插件：dev / preview 注册 /api 转发；configureServer 使用 order:pre，尽量早于其它插件中间件 */
export function viteApiBridgePlugin(): Plugin {
  const mw = createApiBridgeProxyMiddleware();
  return {
    name: 'vite-api-bridge-proxy',
    enforce: 'pre',
    configureServer: {
      order: 'pre',
      handler(server) {
        server.middlewares.use(mw);
      },
    },
    configurePreviewServer: {
      order: 'pre',
      handler(server) {
        server.middlewares.use(mw);
      },
    },
  };
}
