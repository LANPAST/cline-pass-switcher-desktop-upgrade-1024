// 能力过滤（providerOptions.gateway.has）离线测试。
//
// 覆盖 2026-10-23 实测结论在代码里的落点：
//   1. 规划器管道钉住上游时，请求体必须同时带 only 与 has；
//   2. /api/verify-pin 的两组对照：A 组命中目标上游、B 组的无效上游被拒绝；
//   3. 保存配置时没传 has 的「规划器 + 只钉 deepseek」会补上实测组合；
//   4. 直连管道（OpenRouter）不注入 providerOptions.has。
//
// 全程用本地假上游，不碰真实 Cline 账号与网络。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
const ok = (name) => { results.push([name, true]); console.log('  ✓ ' + name); };
const fail = (name, detail) => { results.push([name, false]); console.error('  ✗ ' + name + (detail ? '：' + detail : '')); };
function assert(cond, name, detail) {
  if (cond) ok(name);
  else fail(name, detail);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// 假上游：记录每个请求体；对无效 only 返回 400，否则回一段带 finalProvider 的 SSE。
const seen = [];
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    seen.push(body);
    const only = body?.providerOptions?.gateway?.only?.[0];
    const caps = body?.providerOptions?.gateway?.has;
    // 模拟「单独的 only 被服务端忽略」：无 has 的 __probe__ 会成功；带 has 才在路由层报错。
    if (only === '__probe__' && Array.isArray(caps) && caps.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Available providers are: deepseek, alibaba.' }));
    }
    if (only === 'not-a-real-provider' || (only && only !== 'deepseek' && only !== '__probe__')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No matching providers found for the requested model.' }));
    }
    if (body?.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        provider_metadata: { gateway: { routing: { finalProvider: 'deepseek', canonicalSlug: 'deepseek/deepseek-v4.1-flash' } } },
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'OK', provider_metadata: { gateway: { routing: { finalProvider: 'deepseek' } } } } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const upstreamPort = fake.address().port;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-has-'));
const port = await freePort();
const MODEL = 'cline-pass/deepseek-v4.1-flash-1017';
const PRO_MODEL = 'cline-pass/deepseek-v4-pro';
const BLIND_MODEL = 'cline-pass/deepseek-v4.1-flash';
const DIRECT_MODEL = 'cline-pass/glm-5.3-flash';
const RELAY_MODEL = 'cline-pass/kimi-k3';
const HAS = ['vision', 'implicit-caching'];

fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  port,
  upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v1`,
  accounts: [{ name: 'test', key: 'sk_test', enabled: true }],
  accountMode: 'single',
  activeAccount: 0,
  knownModels: [MODEL],
  perModel: {
    [MODEL]: { upstream: 'deepseek', upstreams: ['deepseek'], exclude: [], pinMode: 'strict', sort: null, has: HAS },
  },
}, null, 2));
fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
  models: {
    [MODEL]: { pipeline: 'planner', upstreams: ['deepseek', 'alibaba'], provider: 'openai-compatible-private' },
    [PRO_MODEL]: { pipeline: 'planner', upstreams: ['deepseek', 'alibaba'] },
    [BLIND_MODEL]: { pipeline: 'planner', upstreams: [] },
    [DIRECT_MODEL]: { pipeline: 'direct', upstreams: ['z-ai', 'deepinfra'] },
    [RELAY_MODEL]: { pipeline: 'planner', upstreams: [] },
  },
  history: [],
}, null, 2));

process.env.DATA_DIR = dir;
const eng = await import('../src/main/engine/engine.js');
await eng.start({ port });

const base = `http://127.0.0.1:${port}`;
const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, text, json };
};

try {
  console.log('\n[1] 规划器管道：only 与 has 一起注入');
  seen.length = 0;
  const chat = await post('/v1/chat/completions', {
    model: MODEL, stream: true,
    messages: [{ role: 'user', content: '只回复 OK' }],
  });
  const sent = seen[0];
  assert(chat.status === 200, '代理请求返回 200', String(chat.status));
  assert(JSON.stringify(sent?.providerOptions?.gateway?.only) === JSON.stringify(['deepseek']),
    '请求体带 providerOptions.gateway.only = ["deepseek"]', JSON.stringify(sent?.providerOptions));
  assert(JSON.stringify(sent?.providerOptions?.gateway?.has) === JSON.stringify(HAS),
    '请求体带 providerOptions.gateway.has = vision + implicit-caching', JSON.stringify(sent?.providerOptions));
  assert(sent?.provider === undefined, '规划器管道不注入顶层 provider');
  assert(chat.text.includes('"finalProvider":"deepseek"'), '流式响应能回读 finalProvider');

  // 中转不能吞掉客户端自己带来的路由扩展字段（截图里的「extraBody / providerOptions」）
  seen.length = 0;
  await post('/v1/chat/completions', {
    model: RELAY_MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    providerOptions: { gateway: { only: ['deepseek'], has: ['vision'] } },
  });
  assert(seen[0]?.providerOptions?.gateway?.only?.[0] === 'deepseek' &&
    seen[0]?.providerOptions?.gateway?.has?.[0] === 'vision',
    '客户端带来的 providerOptions 原样透传（没配置钉住时也不丢）', JSON.stringify(seen[0]?.providerOptions));

  console.log('\n[2] 两组对照验证：/api/verify-pin');
  seen.length = 0;
  const v = await post('/api/verify-pin', { model: MODEL, upstream: 'deepseek' });
  assert(v.status === 200 && v.json?.applicable === true, '验证接口可用', JSON.stringify(v.json));
  assert(v.json?.a?.actual === 'deepseek' && v.json?.a?.matched === true, 'A 组命中目标上游', JSON.stringify(v.json?.a));
  assert(v.json?.b?.rejected === true, 'B 组的无效上游被拒绝', JSON.stringify(v.json?.b));
  assert(v.json?.enforced === true, '结论：能力过滤让 only 生效', JSON.stringify(v.json?.note));
  assert(seen.length === 2, '正好发出两组请求', String(seen.length));
  assert(seen[1]?.providerOptions?.gateway?.only?.[0] === 'not-a-real-provider', 'B 组确实把 only 换成不存在的上游');

  console.log('\n[3] 保存配置：未传 has 的 deepseek 钉住自动补实测组合');
  const save = await post('/api/config', {
    perModel: { [MODEL]: { upstreams: ['deepseek'], exclude: [], pinMode: 'strict', sort: null } },
  });
  assert(save.status === 200, '保存配置返回 200', String(save.status));
  const cfg = await (await fetch(base + '/api/config')).json();
  assert(JSON.stringify(cfg?.perModel?.[MODEL]?.has) === JSON.stringify(HAS),
    'GET /api/config 里 has 被补成实测组合', JSON.stringify(cfg?.perModel?.[MODEL]));

  // v4-pro 是纯文本模型：带 vision 会一个上游都匹配不到；只带 implicit-caching 又没实测证据，
  // 所以默认不自动开启（交给渠道编辑里的两组请求验证）。
  await post('/api/config', {
    perModel: { [PRO_MODEL]: { upstreams: ['deepseek'], exclude: [], pinMode: 'strict', sort: null } },
  });
  const cfgPro = await (await fetch(base + '/api/config')).json();
  assert(JSON.stringify(cfgPro?.perModel?.[PRO_MODEL]?.has) === JSON.stringify([]),
    '纯文本 DeepSeek 模型不自动启用能力过滤（避免带 vision 把上游全排除）', JSON.stringify(cfgPro?.perModel?.[PRO_MODEL]));

  // 用户实际场景：探测不到任何渠道（upstreams 为空），只能手动把 deepseek 填进钉住链。
  // 钉住不依赖 meta.upstreams，所以手动链同样能下发 only + has。
  await post('/api/config', {
    perModel: { [BLIND_MODEL]: { upstreams: ['deepseek'], exclude: [], pinMode: 'strict', sort: null } },
  });
  seen.length = 0;
  await post('/v1/chat/completions', {
    model: BLIND_MODEL, stream: true,
    messages: [{ role: 'user', content: '只回复 OK' }],
  });
  const blind = seen[0];
  assert(blind?.providerOptions?.gateway?.only?.[0] === 'deepseek',
    '渠道清单为空时，手动钉住 deepseek 仍然下发 only', JSON.stringify(blind?.providerOptions));
  assert(blind?.providerOptions?.gateway?.has?.includes('implicit-caching'),
    '手动钉住时按模型补上 has', JSON.stringify(blind?.providerOptions));

  console.log('\n[4] 直连管道：不注入 providerOptions.has');
  await post('/api/config', {
    perModel: { [DIRECT_MODEL]: { upstreams: ['z-ai'], exclude: [], pinMode: 'strict', sort: null, has: HAS } },
  });
  const cfg2 = await (await fetch(base + '/api/config')).json();
  assert(JSON.stringify(cfg2?.perModel?.[DIRECT_MODEL]?.has) === JSON.stringify(HAS),
    '直连模型的能力过滤配置被保留（只是不发送）', JSON.stringify(cfg2?.perModel?.[DIRECT_MODEL]));
  seen.length = 0;
  const chat2 = await post('/v1/chat/completions', {
    model: DIRECT_MODEL,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const sent2 = seen[0];
  assert(chat2.status === 200, '直连代理请求返回 200', String(chat2.status));
  assert(JSON.stringify(sent2?.provider?.only) === JSON.stringify(['z-ai']),
    '直连管道仍用顶层 provider.only', JSON.stringify(sent2?.provider));
  assert(sent2?.providerOptions === undefined, '直连管道不带 providerOptions');

  console.log('\n[5] 渠道枚举：无效 only 被忽略时，带 has 再探一次');
  seen.length = 0;
  const probe = await post('/api/probe', { model: MODEL });
  assert(probe.status === 200 && probe.json?.ok === true, '探测成功', JSON.stringify(probe.json)?.slice(0, 200));
  const ups = probe.json?.upstreams || [];
  assert(ups.includes('deepseek') && ups.includes('alibaba'), '从带 has 的错误里读回渠道清单', JSON.stringify(ups));
  assert(seen.length === 3, '探测共 3 次请求（主探测 + 无 has + 带 has）', String(seen.length));
  assert(Array.isArray(seen[1]?.providerOptions?.gateway?.has) === false, '第一次枚举没有带 has（复现 only 被忽略）');
  assert(Array.isArray(seen[2]?.providerOptions?.gateway?.has) && seen[2].providerOptions.gateway.has.length > 0,
    '第二次枚举带上了 has', JSON.stringify(seen[2]?.providerOptions));
} finally {
  await eng.stop().catch(() => {});
  await new Promise((r) => fake.close(r));
  await sleep(10);
  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter(([, pass]) => !pass);
console.log('\n' + (failed.length ? `✗ ${failed.length} 项失败` : `✓ ${results.length} 项全部通过`));
if (failed.length) process.exit(1);