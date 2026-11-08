#!/usr/bin/env node
/**
 * service worker 行為測試（離線，不花錢）
 *
 * 在 Node 裡用假的 chrome.storage 與假的 fetch（模擬 Anthropic）把 sw.js 真的跑一遍：
 *   1. 沒有 API key：不呼叫模型、回「還沒設定 API key」
 *   2. 有 key：送出的請求格式正確（標頭、system prompt、cache_control），譯文以 normKey 為鍵回來
 *   3. 本機快取：同一句第二次不再呼叫模型；getBundle 拿得到；markComplete 記得 segCount
 *   4. 譯文守門：模型的自言自語不顯示也不存
 *   5. 錯開一格：模型跳過一行時，後半會拆開重翻，不會把下一句的譯文給上一句
 *   6. 401 的錯誤訊息講得出「API key 無效」
 *   7. fetchText 的網址白名單
 *
 * 用法：node tools/test-sw.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'extension');
const fails = [];
function ok(cond, msg) { if (!cond) fails.push(msg); }

// ---- 假的 chrome --------------------------------------------------------
const store = {};
let listener = null;
const chrome = {
  runtime: {
    id: 'self',
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { listener = fn; } },
    openOptionsPage: () => Promise.resolve(),
  },
  storage: {
    local: {
      async get(keys) {
        const ks = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
        const o = {};
        for (const k of ks) if (k in store) o[k] = JSON.parse(JSON.stringify(store[k]));
        return o;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v)); },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
    },
  },
};

// ---- 假的 Anthropic -----------------------------------------------------
const calls = [];
let reply = null;   // (body) => { status, json }
async function fakeFetch(url, opts) {
  if (url !== 'https://api.anthropic.com/v1/messages') throw new Error('unexpected fetch ' + url);
  const body = JSON.parse(opts.body);
  calls.push({ headers: opts.headers, body });
  const r = reply(body);
  return {
    ok: r.status === 200, status: r.status,
    json: async () => r.json,
    text: async () => JSON.stringify(r.json),
  };
}
function textReply(text) {
  return { status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4800 } } };
}

// ---- 載入 sw.js ---------------------------------------------------------
const sandbox = {
  chrome, fetch: fakeFetch, console, setTimeout, clearTimeout, URL, Promise,
  importScripts(...files) {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  },
};
sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
// 'use strict'：真的 SW 對未宣告變數賦值會丟 ReferenceError，vm 預設不會
vm.runInContext('"use strict";' + fs.readFileSync(path.join(root, 'src/background/sw.js'), 'utf8'), ctx, { filename: 'sw.js' });

function send(msg) {
  return new Promise((resolve) => {
    const keep = listener(msg, { id: 'self' }, resolve);
    if (keep !== true) resolve(undefined);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PL = sandbox.PL;

(async () => {
  // 1. 沒有 key
  reply = () => textReply('不該被呼叫');
  let r = await send({ type: 'translate', cid: '1000001', lines: ['Box box box'] });
  ok(calls.length === 0, '1. 沒有 API key 時不可以呼叫模型');
  ok(r.result && /API key/.test(r.result.error || ''), '1. 沒有 API key 時要回「還沒設定 API key」：' + JSON.stringify(r));
  r = await send({ type: 'licenseStatus' });
  ok(r.license && r.license.active === false, '1. 沒有 key 時 licenseStatus 要是 inactive');

  // 2. 有 key：批次
  await chrome.storage.local.set({ apiKey: 'sk-ant-test' });
  r = await send({ type: 'licenseStatus' });
  ok(r.license && r.license.active === true, '2. 有 key 時 licenseStatus 要是 active');
  reply = () => textReply('1. 進站、進站、進站\n2. 他要嘗試搶先進站策略');
  r = await send({ type: 'translate', cid: '1000001', lines: ['Box, box, box!', 'He is going for the undercut'] });
  const c0 = calls[0];
  ok(c0 && c0.headers['x-api-key'] === 'sk-ant-test', '2. 要帶 x-api-key');
  ok(c0 && c0.headers['anthropic-dangerous-direct-browser-access'] === 'true', '2. 要帶 anthropic-dangerous-direct-browser-access');
  ok(c0 && c0.headers['anthropic-version'] === '2023-06-01', '2. 要帶 anthropic-version');
  ok(c0 && c0.body.model === 'claude-haiku-4-5', '2. 預設模型是 claude-haiku-4-5');
  ok(c0 && c0.body.system[0].text === PL.SYSTEM_PROMPT && c0.body.system[0].cache_control, '2. system prompt 與 cache_control');
  ok(c0 && /^【批次翻譯】共 2 句\n1\. Box, box, box!\n2\. He is going for the undercut$/.test(c0.body.messages[0].content), '2. 批次格式');
  const k1 = PL.normKey('Box, box, box!');
  ok(r.result.lines[k1] === '進站、進站、進站', '2. 譯文要以 normKey 為鍵回來：' + JSON.stringify(r.result));

  // 3. 本機快取
  const n = calls.length;
  r = await send({ type: 'translate', cid: '1000001', lines: ['BOX BOX BOX'] });
  ok(calls.length === n, '3. 快取命中時不可以再呼叫模型');
  ok(r.result.lines[k1] === '進站、進站、進站', '3. 快取命中要回譯文');
  await wait(2300);   // 等快取落地
  ok(store['c:1000001'] && store['c:1000001'].lines[k1], '3. 譯文要寫進 chrome.storage.local');
  ok(Array.isArray(store.cIdx) && store.cIdx[0] === '1000001', '3. 快取索引');
  r = await send({ type: 'markComplete', cid: '1000001', segCount: 42 });
  await wait(2300);
  r = await send({ type: 'getBundle', cid: '1000001' });
  ok(r.bundle.segCount === 42 && r.bundle.count === 2, '3. getBundle 要回 segCount 與句數：' + JSON.stringify(r.bundle));
  ok(store.usage && store.usage.calls === 1 && store.usage.cacheRead === 4800, '3. 用量要記下來：' + JSON.stringify(store.usage));

  // 4. 譯文守門
  reply = () => textReply('我沒有收到任何內容，請提供需要翻譯的原文。');
  r = await send({ type: 'translate', cid: '1000002', lines: ['go'] });
  ok(!Object.keys(r.result.lines).length, '4. 模型自言自語不可以顯示：' + JSON.stringify(r.result));

  // 5. 錯開一格：模型把第 2 句跳掉，第 2 號拿到第 3 句（Hamilton）的譯文
  const lines5 = ['Verstappen leads into turn one', 'Norris is right behind him', 'Hamilton pits from fifth'];
  reply = (body) => {
    const u = body.messages[0].content;
    if (/共 3 句/.test(u)) return textReply('1. Verstappen 領先進入一號彎\n2. Hamilton 從第五名進站\n3. （空）');
    // 錯開後拆成兩半、各一句重翻（單句不走編號）
    if (u === 'Norris is right behind him') return textReply('Norris 緊跟在後');
    if (u === 'Hamilton pits from fifth') return textReply('Hamilton 從第五名進站');
    return textReply('??');
  };
  r = await send({ type: 'translate', cid: '1000003', lines: lines5 });
  const L = r.result.lines;
  ok(L[PL.normKey(lines5[1])] === 'Norris 緊跟在後', '5. 錯開時第 2 句要拿到自己的譯文：' + JSON.stringify(L));
  ok(L[PL.normKey(lines5[2])] === 'Hamilton 從第五名進站', '5. 錯開時第 3 句要拿到自己的譯文：' + JSON.stringify(L));
  ok(L[PL.normKey(lines5[0])] === 'Verstappen 領先進入一號彎', '5. 錯開之前的句子照收');

  // 6. 401
  reply = () => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
  r = await send({ type: 'translate', cid: '1000004', lines: ['Safety car deployed'] });
  ok(/API key 無效/.test(r.result.error || ''), '6. 401 要說 API key 無效：' + JSON.stringify(r.result));

  // 7. 網址白名單
  r = await send({ type: 'fetchText', url: 'https://evil.example.com/x.m3u8' });
  ok(r.ok === false && /允許清單/.test(r.error), '7. 白名單外的網址要拒絕');
  r = await send({ type: 'fetchText', url: 'https://x.akamaized.net/x.m3u8' });
  ok(r.ok === false, '7. 不可以放行任意 akamaized.net 主機');

  // 8. 其他擴充功能送來的訊息不理
  const keep = listener({ type: 'licenseStatus' }, { id: 'other' }, () => {});
  ok(keep === false, '8. 別的擴充功能的訊息不可以處理');

  if (fails.length) {
    console.log('❌ service worker 測試失敗\n');
    fails.forEach((f) => console.log('   ' + f));
    process.exit(1);
  }
  console.log('✅ service worker：沒 key 不呼叫、請求格式、本機快取、守門、錯開一格、401 訊息、網址白名單');
})().catch((e) => { console.log('❌ 測試本身出錯：', e); process.exit(1); });
