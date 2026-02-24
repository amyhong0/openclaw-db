#!/usr/bin/env node
/**
 * OpenClaw gateway 상태 수집 → status.json 생성 → GCS 업로드
 * 로컬에서 cron으로 주기 실행 (예: 1분마다)
 *
 * 사용법:
 *   node collect-to-gcs.mjs
 *   node collect-to-gcs.mjs --upload gs://YOUR_BUCKET
 *   GCS_BUCKET=gs://my-bucket node collect-to-gcs.mjs
 */

import WebSocket from 'ws';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
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

// 게이트웨이 로그에서 프로바이더별 rate limit / cooldown 이벤트 파싱
function parseRateLimitEvents() {
  const logDir = '/tmp/openclaw';
  const now = Date.now();
  const events = {};

  // 오늘·어제 로그 파일 모두 확인 (날짜 경계 대비)
  const dates = [
    new Date(now).toISOString().split('T')[0],
    new Date(now - 86400000).toISOString().split('T')[0],
  ];

  // 탐지 패턴 (대소문자 무시)
  const PATTERNS = {
    anthropic: [
      'provider anthropic is in cooldown',
      'anthropic/claude',
    ],
    google: [
      'no available auth profile for google',
      'provider google',
      'google/gemini',
    ],
  };

  // Anthropic 5h rolling, Google 1h 기준으로 리셋 추정
  const RESET_MS = { anthropic: 5 * 3600 * 1000, google: 60 * 60 * 1000 };

  for (const dateStr of dates) {
    const logFile = `${logDir}/openclaw-${dateStr}.log`;
    if (!existsSync(logFile)) continue;
    let content = '';
    try { content = readFileSync(logFile, 'utf8'); } catch (_) { continue; }

    for (const line of content.split('\n')) {
      if (!line) continue;
      const lower = line.toLowerCase();
      // 관심 키워드가 없는 줄은 건너뜀
      if (!lower.includes('cooldown') && !lower.includes('rate_limit') &&
          !lower.includes('rate limit') && !lower.includes('overload') &&
          !lower.includes('anthropic') && !lower.includes('google/gemini')) continue;

      let ts = null;
      let text = lower;
      try {
        const entry = JSON.parse(line);
        const rawTime = entry.time || entry._meta?.date;
        if (rawTime) ts = new Date(rawTime).getTime();
        text = [entry['0'], entry['1']].filter(Boolean).join(' ').toLowerCase();
      } catch (_) {
        // JSON 파싱 실패 시 타임스탬프 추출 시도
        const m = line.match(/"time":"([^"]+)"/);
        if (m) ts = new Date(m[1]).getTime();
      }
      if (!ts) continue;

      for (const [provider, patterns] of Object.entries(PATTERNS)) {
        const matched = patterns.some(p => text.includes(p));
        // generic rate_limit ("API rate limit reached") → anthropic로 귀속
        const isGenericRL = provider === 'anthropic' &&
          (text.includes('api rate limit reached') || text.includes('failovererror'));

        if (matched || isGenericRL) {
          if (!events[provider] || events[provider].lastAt < ts) {
            const estimatedResetAt = ts + RESET_MS[provider];
            events[provider] = {
              lastAt: ts,
              estimatedResetAt,
              inCooldown: estimatedResetAt > now,
            };
          }
        }
      }
    }
  }

  return events;
}

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
            const sessList = sessions?.sessions || [];
            const ext = (m) => {
      if (!m?.content) return '';
      const c = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.map(x => {
          if (x.type === 'text') return x.text || '';
          if (x.type === 'tool_result' || x.type === 'tool_output') return x.output || x.content || x.text || '';
          return '';
        }).filter(Boolean).join('\n');
      }
      return (c.output || c.text || '');
    };

            const allSessionKeys = new Set();
            byAgent.forEach(a => (a.recent || []).forEach(s => allSessionKeys.add(s.key)));
            sessList.forEach(s => s?.key && allSessionKeys.add(s.key));

            for (const sessionKey of allSessionKeys) {
              const agentId = sessionKey.split(':')[1] || 'main';
              try {
                const hist = await rpc(ws, 'chat.history', { sessionKey, limit: 150 });
                if (!hist?.messages?.length) continue;
                const msgs = hist.messages;
                const firstUser = msgs.find(m => m.role === 'user');
                const lastAsst = [...msgs].reverse().find(m => m.role === 'assistant');
                if (!taskMap[agentId]) {
                  taskMap[agentId] = {
                    task: (ext(firstUser) || '').slice(0, 100),
                    lastMsg: (ext(lastAsst) || '').slice(0, 150),
                    status: msgs[msgs.length - 1]?.role === 'assistant' ? 'responded' : 'waiting',
                    sessionKey
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

            for (const id of Object.keys(chatHistory)) {
              chatHistory[id].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            }

            const rateLimitEvents = parseRateLimitEvents();
            const payload = {
              updatedAt: new Date().toISOString(),
              health, status, presence, usage, cost, sessions,
              taskMap, chatHistory, rateLimitEvents
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
