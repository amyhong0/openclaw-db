#!/usr/bin/env node
/**
 * OpenClaw gateway 상태 수집 → status.json 생성 → GCS 업로드
 * 로컬에서 cron으로 주기 실행 (예: 2분마다)
 *
 * 사용법:
 *   node collect-to-gcs.mjs
 *   node collect-to-gcs.mjs --upload gs://YOUR_BUCKET
 *   GCS_BUCKET=gs://my-bucket node collect-to-gcs.mjs
 */

import WebSocket from 'ws';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const GW_WS = process.env.OPENCLAW_GW_WS || 'ws://localhost:18789';
const GW_TOKEN = process.env.OPENCLAW_GW_TOKEN || getTokenFromConfig();
const idx = process.argv.indexOf('--upload');
const GCS_BUCKET = process.env.GCS_BUCKET ||
  (process.argv.find(a => a.startsWith('--upload='))?.replace('--upload=', '')) ||
  (idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null);
const OUTPUT = join(__dirname, 'status.json');

function getTokenFromConfig() {
  try {
    const cfg = JSON.parse(readFileSync(process.env.HOME + '/.openclaw/openclaw.json', 'utf8'));
    return cfg?.gateway?.auth?.token || cfg?.gateway?.remote?.token;
  } catch (e) {
    return null;
  }
}

function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(Date.now() + Math.random());
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.off('message', handler);
          resolve(msg.ok ? msg.payload : null);
        }
      } catch (_) {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    setTimeout(() => {
      ws.off('message', handler);
      resolve(null);
    }, 15000);
  });
}

async function connectAndCollect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GW_WS, { headers: { Origin: 'http://localhost:8080' } });

    ws.on('open', () => {
      const frame = {
        type: 'req', id: 'connect', method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'openclaw-control-ui', version: 'collect', platform: 'web', mode: 'webchat' },
          role: 'operator', scopes: ['operator.admin', 'operator.read'],
          auth: { token: GW_TOKEN }
        }
      };
      ws.send(JSON.stringify(frame));
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'res' && msg.id === 'connect') {
          if (!msg.ok) {
            ws.close();
            reject(new Error(msg.error?.message || 'Connect failed'));
            return;
          }
          try {
            const [health, status, presence, usage, cost, sessions] = await Promise.all([
              rpc(ws, 'health'),
              rpc(ws, 'status'),
              rpc(ws, 'system-presence'),
              rpc(ws, 'usage.status'),
              rpc(ws, 'usage.cost'),
              rpc(ws, 'sessions.list')
            ]);

            const taskMap = {};
            const chatHistory = {};
            const byAgent = status?.sessions?.byAgent || [];

            for (const a of byAgent.filter(x => x.recent?.length > 0).slice(0, 5)) {
              const agentId = a.agentId;
              for (const sess of a.recent.slice(0, 2)) {
                try {
                  const hist = await rpc(ws, 'chat.history', { sessionKey: sess.key, limit: 30 });
                  if (!hist?.messages?.length) continue;
                  const msgs = hist.messages;
                  const firstUser = msgs.find(m => m.role === 'user');
                  const lastAsst = [...msgs].reverse().find(m => m.role === 'assistant');
                  const ext = (m) => Array.isArray(m?.content) ? (m.content.find(c => c.type === 'text')?.text || '') : (m?.content || '');
                  if (!taskMap[agentId]) {
                    taskMap[agentId] = {
                      task: (ext(firstUser) || '').slice(0, 100),
                      lastMsg: (ext(lastAsst) || '').slice(0, 150),
                      status: msgs[msgs.length - 1]?.role === 'assistant' ? 'responded' : 'waiting',
                      sessionKey: sess.key
                    };
                  }
                  if (!chatHistory[agentId]) chatHistory[agentId] = [];
                  chatHistory[agentId].push(...msgs.map(m => ({
                    role: m.role,
                    content: ext(m),
                    timestamp: m.timestamp
                  })).filter(m => m.content));
                } catch (_) {}
              }
            }

            const payload = {
              updatedAt: new Date().toISOString(),
              health, status, presence, usage, cost, sessions,
              taskMap, chatHistory
            };
            writeFileSync(OUTPUT, JSON.stringify(payload, null, 0), 'utf8');
            resolve(payload);
          } catch (e) {
            reject(e);
          } finally {
            ws.close();
          }
        }
      } catch (e) {
        reject(e);
      }
    });

    ws.on('error', reject);
    ws.on('close', (code, reason) => {
      if (code !== 1000) reject(new Error(`Closed: ${code} ${reason}`));
    });
  });
}

function uploadToGcs(bucket) {
  return new Promise((resolve, reject) => {
    const dest = bucket.replace(/\/$/, '') + '/status.json';
    const proc = spawn('gsutil', ['-h', 'Cache-Control:no-cache', 'cp', OUTPUT, dest], {
      stdio: 'inherit'
    });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`gsutil exit ${code}`)));
  });
}

async function main() {
  if (!GW_TOKEN) {
    console.error('OPENCLAW_GW_TOKEN or ~/.openclaw/openclaw.json gateway.auth.token 필요');
    process.exit(1);
  }
  try {
    await connectAndCollect();
    console.log('Collected →', OUTPUT);
    if (GCS_BUCKET) {
      await uploadToGcs(GCS_BUCKET);
      console.log('Uploaded →', GCS_BUCKET + '/status.json');
    } else {
      console.log('GCS 업로드: GCS_BUCKET=gs://버킷이름 node collect-to-gcs.mjs');
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

main();
