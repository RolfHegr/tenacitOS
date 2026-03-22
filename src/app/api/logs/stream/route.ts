/**
 * Real-time log streaming via SSE
 * GET /api/logs/stream?service=<name>&backend=<pm2|systemd|file>
 */
import { NextRequest } from 'next/server';
import { spawn } from 'child_process';

const ALLOWED_SERVICES = ['mission-control', 'classvault', 'content-vault', 'postiz-simple', 'brain', 'openclaw-gateway'];

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const service = searchParams.get('service') || 'mission-control';
  const backend = searchParams.get('backend') || 'systemd';

  if (!ALLOWED_SERVICES.includes(service)) {
    return new Response('Service not allowed', { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ line: data, ts: new Date().toISOString() })}\n\n`));
        } catch {}
      };

      send(`[stream] Connected to ${service} (${backend})`);

      let cmd: string[];
      if (backend === 'pm2') {
        cmd = ['pm2', 'logs', service, '--lines', '50', '--nocolor'];
      } else {
        // journalctl is Linux-only. On macOS, fall back to OpenClaw log files.
        const openclawDir = process.env.OPENCLAW_DIR || '/Users/rolfy/.openclaw';
        const logFile = `${openclawDir}/logs/${service}.log`;
        send(`[info] systemd/journalctl not available on macOS. Trying ${logFile}`);
        cmd = ['tail', '-n', '50', '-f', logFile];
      }

      const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });

      proc.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          send(line);
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          send(line);
        }
      });

      proc.on('error', (err) => {
        send(`[error] ${err.message}`);
        try { controller.close(); } catch {}
      });

      proc.on('close', () => {
        send('[stream] Process ended');
        try { controller.close(); } catch {}
      });

      // Cleanup on disconnect
      request.signal?.addEventListener('abort', () => {
        proc.kill();
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
