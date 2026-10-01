import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

export interface StaticServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Minimal static file server for the built Storybook.
 *
 * A dependency would buy nothing here: the surface is one GET handler, and owning it keeps
 * the runtime dependency list at zero (docs/decisions.md, D-015).
 */
export async function serveStatic(root: string, port = 0): Promise<StaticServer> {
  const absoluteRoot = path.resolve(root);

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        // A malformed percent-escape is a client error; letting URIError reach the catch
        // below would answer 500 for a URL that never named a file at all.
        let decoded: string;
        try {
          decoded = decodeURIComponent(requestUrl.pathname);
        } catch {
          res.writeHead(400).end('Bad request');
          return;
        }

        // Resolve inside the root, then verify: a `..` segment must not escape the build.
        const candidate = path.resolve(absoluteRoot, `.${path.posix.normalize(decoded)}`);
        if (candidate !== absoluteRoot && !candidate.startsWith(absoluteRoot + path.sep)) {
          res.writeHead(403).end('Forbidden');
          return;
        }

        let filePath = candidate;
        const info = await stat(filePath).catch(() => undefined);
        if (info?.isDirectory()) filePath = path.join(filePath, 'index.html');
        else if (!info) {
          res.writeHead(404).end('Not found');
          return;
        }

        const fileInfo = await stat(filePath).catch(() => undefined);
        if (!fileInfo?.isFile()) {
          res.writeHead(404).end('Not found');
          return;
        }

        const stream = createReadStream(filePath);
        // Headers wait for the stream to open: a file that vanishes between the stat and
        // the open — or refuses read access — must still answer 500, which is impossible
        // once a 200 with a promised length is on the wire. And without a handler the
        // error on the stream would take the whole process down.
        stream.once('open', () => {
          res.writeHead(200, {
            'Content-Type':
              MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': fileInfo.size,
            'Cache-Control': 'no-store',
          });
          stream.pipe(res);
        });
        stream.on('error', () => {
          if (!res.headersSent) res.writeHead(500);
          res.end('Internal error');
        });
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal error');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export { storyUrlFor } from './runtime/capture.ts';
