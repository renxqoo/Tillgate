import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** 本地 mock 上游：随机端口 + 127.0.0.1（配合 fetchUpstream 的 allowLocal） */
export type MockHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface MockUpstream {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startServer(handler: MockHandler): Promise<MockUpstream> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** OpenAI 兼容 SSE data 帧 */
export const sseFrame = (data: string): string => `data: ${data}\n\n`;

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
