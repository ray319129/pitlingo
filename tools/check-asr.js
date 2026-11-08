#!/usr/bin/env node
/**
 * 語音辨識字幕的測試端點（/v1/asr/test，2026-09-17）。
 *
 * 這個端點**會花錢**（語音辨識 + 翻譯），而且只有測試版在用，
 * 所以最重要的不是「辨識得準」，是下面這幾件事絕對成立：
 *
 *   1. 沒設 ASR_TEST_KEY、或金鑰不對 → 404（對外看起來不存在）
 *   2. 沒有辨識服務金鑰 → 明確的 E70，不是默默回空字幕
 *   3. 每日分鐘上限真的擋得住（E72），擋下時**不呼叫**辨識服務
 *   4. 辨識服務出錯 → E73 且不計入用量
 *   5. Deepgram 與 OpenAI 的回應都解析得出逐句時間
 *   6. 靜音時模型「聽出來」的幻覺句被濾掉
 *   7. 翻譯被守門擋下的句子 zh 是空字串，不是把模型的自言自語顯示出來
 *   8. **辨識結果不寫進共用快取**（handoff 9.1 #21）
 *
 * 全部用假的 fetch，不花錢。
 * 用法：node tools/check-asr.js
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { readBackend } = require('./lib/backend-src');

// ⚠️ 'use strict'：見 check-credit.js 的說明（坑 #37）
const src = "'use strict';\n" + readBackend()
  .replace(/export default \{[\s\S]*?\n\};\r?\n/, '')
  .replace(/\bexport\s+class\s+/g, 'class ');

const cacheStore = new Map();
const calls = [];
let fetchImpl = async () => { throw new Error('沒有預期的 fetch'); };

const sb = {
  crypto: require('crypto').webcrypto, TextEncoder, TextDecoder, btoa, atob,
  Response, Request, Headers, FormData, Blob, URL, URLSearchParams,
  console, Date, Math, JSON, Map, Set, Promise, RegExp, Error, Array, Object, String, Number, Boolean,
  Uint8Array, ArrayBuffer, DataView, setTimeout, clearTimeout, parseInt, parseFloat, isNaN, Intl,
  fetch: async (url, init) => { calls.push(String(url)); return fetchImpl(String(url), init || {}); },
  caches: { default: {
    match: async (k) => (cacheStore.has(k) ? new Response(cacheStore.get(k)) : undefined),
    put: async (k, r) => { cacheStore.set(k, await r.text()); },
  } },
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src + '\n;this.__api={handleAsrTest,handleAsrTranslate,ASR_HALLUCINATION,ASR_TRANSLATE_MAX_LINES,statsSnapshot:()=>JSON.parse(JSON.stringify(pending_))};', sb);
const A = sb.__api;

const kv = new Map();
const baseEnv = () => ({
  ASR_TEST_KEY: 'k-test-123', ANTHROPIC_API_KEY: 'x',
  SUBS: {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
    list: async () => ({ keys: [], list_complete: true }),
  },
});

let failed = 0;
const ok = (m) => console.log('✅ ' + m);
const bad = (m) => { failed++; console.log('❌ ' + m); };
const expect = (cond, m, detail) => (cond ? ok(m) : bad(m + (detail !== undefined ? '：' + JSON.stringify(detail) : '')));

function wav(sec) { return new Uint8Array(44 + Math.round(sec * 32000)); }
function req(body, key, query) {
  const h = { 'content-type': 'audio/wav' };
  if (key !== undefined) h['x-asr-key'] = key;
  return new Request('https://api.pitlingo.com/v1/asr/test' + (query || ''), { method: 'POST', headers: h, body });
}
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
function anthropic(text) {
  return jsonRes({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } });
}
async function call(env, body, key, query) {
  const r = await A.handleAsrTest(req(body, key, query), env);
  let data = null;
  try { data = JSON.parse(await r.text()); } catch (e) { /* 非 JSON */ }
  return { status: r.status, data };
}

(async () => {
  // ---- 1. 門 ----
  {
    const env = baseEnv(); delete env.ASR_TEST_KEY; env.DEEPGRAM_API_KEY = 'dg';
    calls.length = 0;
    const r1 = await call(env, wav(5), 'k-test-123');
    expect(r1.status === 404 && !calls.length, '沒設 ASR_TEST_KEY → 404，而且沒有呼叫任何外部服務', r1);
    const env2 = baseEnv(); env2.DEEPGRAM_API_KEY = 'dg';
    const r2 = await call(env2, wav(5), 'wrong');
    const r3 = await call(env2, wav(5));
    expect(r2.status === 404 && r3.status === 404 && !calls.length, '金鑰錯誤或沒帶金鑰 → 404', [r2.status, r3.status]);
  }

  // ---- 2. 沒有辨識服務 ----
  {
    const r = await call(baseEnv(), wav(5), 'k-test-123');
    expect(r.status === 503 && r.data && r.data.code === 'E70', '沒有 DEEPGRAM／OPENAI 金鑰 → 503 E70', r);
  }

  // ---- 3. 大小 ----
  {
    const env = baseEnv(); env.DEEPGRAM_API_KEY = 'dg'; calls.length = 0;
    const small = await call(env, new Uint8Array(100), 'k-test-123');
    const big = await call(env, new Uint8Array(2 * 1024 * 1024 + 1), 'k-test-123');
    expect(small.status === 400 && big.status === 413 && !calls.length, '太短 400／太長 413，都不呼叫辨識服務', [small.status, big.status]);
  }

  // ---- 5a. Deepgram：逐句時間、幻覺過濾、翻譯、守門 ----
  {
    const env = baseEnv(); env.DEEPGRAM_API_KEY = 'dg'; cacheStore.clear(); calls.length = 0;
    let dgUrl = '', dgAuth = '', prompt = '';
    fetchImpl = async (url, init) => {
      if (url.startsWith('https://api.deepgram.com/')) {
        dgUrl = url; dgAuth = init.headers.authorization;
        return jsonRes({ results: { utterances: [
          { start: 0.2, end: 2.1, transcript: 'Verstappen pits from the lead.', confidence: 0.95 },
          { start: 2.4, end: 3.0, transcript: 'Thank you for watching.', confidence: 0.9 },
          { start: 3.1, end: 3.2, transcript: 'Norris is on the hard tyre.', confidence: 0.2 },
          { start: 3.5, end: 4.8, transcript: 'Leclerc  has  DRS now.', confidence: 0.8 },
        ] } });
      }
      if (url.startsWith('https://api.anthropic.com/')) {
        prompt = JSON.parse(init.body).messages[0].content;
        return anthropic('1. 維斯塔潘從領先位置進站。\n2. 抱歉，我無法翻譯這句，請提供更多上下文。');
      }
      throw new Error('未預期的 ' + url);
    };
    const kvBefore = new Map(kv);
    const r = await call(env, wav(5), 'k-test-123');
    const d = r.data || {};
    expect(r.status === 200 && d.ok && d.provider === 'deepgram', 'Deepgram 回 200', r);
    expect(/model=nova-3/.test(dgUrl) && /keyterm=Verstappen/.test(dgUrl) && dgAuth === 'Token dg',
      'Deepgram 請求帶 nova-3、車手名稱提示詞、Token 認證', dgUrl.slice(0, 120));
    const segs = d.segments || [];
    expect(segs.length === 2 && segs[0].start === 0.2 && segs[0].end === 2.1, '保留逐句時間；低信心（0.2）與幻覺句被丟掉', segs);
    expect(segs.every((s) => !/Thank you for watching/.test(s.en)), '「Thank you for watching.」被當成幻覺濾掉');
    expect(d.dropped === 2, 'dropped 把幻覺與低信心都算進去（診斷看得出丟了多少）', d.dropped);
    expect(segs[1] && segs[1].en === 'Leclerc has DRS now.', '多餘空白被收斂', segs[1]);
    expect(segs[0] && segs[0].zh === '維斯塔潘從領先位置進站。', '譯文對回原句', segs[0]);
    expect(segs[1] && segs[1].zh === '', '模型的自言自語被守門擋下，zh 是空字串（不顯示）', segs[1]);
    expect(/Verstappen pits/.test(prompt) && !/Thank you for watching/.test(prompt), '幻覺句沒有送去翻譯（不花翻譯費）', prompt);
    expect(Math.abs(d.audioSec - 5) < 0.01 && d.usedSec === 5, '音訊秒數與今日用量正確', [d.audioSec, d.usedSec]);
    const bundleWrites = [...kv.keys()].filter((k) => !kvBefore.has(k) && /^(sub|bundle|b:|cid)/i.test(k));
    expect(!bundleWrites.length, '辨識結果沒有寫進共用快取（KV 沒有新增字幕鍵）', bundleWrites);
  }

  // ---- 4. 辨識服務錯誤 → E73，不計用量 ----
  {
    const env = baseEnv(); env.DEEPGRAM_API_KEY = 'dg'; cacheStore.clear();
    fetchImpl = async (url) => (url.startsWith('https://api.deepgram.com/')
      ? new Response('invalid credentials', { status: 401 }) : anthropic(''));
    const r = await call(env, wav(5), 'k-test-123');
    expect(r.status === 502 && r.data && r.data.code === 'E73' && /401/.test(r.data.error), '辨識服務 401 → 502 E73，錯誤訊息帶狀態碼', r);
    const after = [...cacheStore.values()];
    expect(!after.length || after.every((v) => Number(v) === 0), '失敗的那段不計入今日用量', after);
  }

  // ---- 3b. 每日上限 ----
  {
    const env = baseEnv(); env.DEEPGRAM_API_KEY = 'dg'; env.ASR_DAILY_MINUTES = '1'; cacheStore.clear();
    let dg = 0;
    fetchImpl = async (url) => {
      if (url.startsWith('https://api.deepgram.com/')) { dg++; return jsonRes({ results: { utterances: [] } }); }
      return anthropic('');
    };
    const codes = [];
    for (let i = 0; i < 14; i++) codes.push((await call(env, wav(5), 'k-test-123')).status);
    const okN = codes.filter((c) => c === 200).length;
    expect(okN === 12 && codes.slice(12).every((c) => c === 429), '上限 1 分鐘、每段 5 秒：第 13 段起 429', codes);
    expect(dg === 12, '被上限擋下的那幾段沒有呼叫辨識服務（沒有多花錢）', dg);
    const last = await call(env, wav(5), 'k-test-123');
    expect(last.data && last.data.code === 'E72' && last.data.capSec === 60, '429 回 E72 並附上限', last.data);
  }

  // ---- 5b. OpenAI ----
  {
    const env = baseEnv(); env.OPENAI_API_KEY = 'oa'; cacheStore.clear();
    let form = null; let auth = '';
    fetchImpl = async (url, init) => {
      if (url === 'https://api.openai.com/v1/audio/transcriptions') {
        form = init.body; auth = init.headers.authorization;
        return jsonRes({ segments: [
          { start: 0, end: 2.5, text: ' Hamilton is closing the gap.', no_speech_prob: 0.05 },
          { start: 2.5, end: 4, text: ' Please subscribe.', no_speech_prob: 0.1 },
          { start: 4, end: 5, text: ' Crowd noise words', no_speech_prob: 0.9 },
        ] });
      }
      if (url.startsWith('https://api.anthropic.com/')) return anthropic('漢米爾頓正在縮小差距。');
      throw new Error('未預期的 ' + url);
    };
    const r = await call(env, wav(5), 'k-test-123');
    const d = r.data || {};
    expect(r.status === 200 && d.provider === 'openai', '只有 OPENAI_API_KEY 時改用 OpenAI', r);
    expect(form && form.get('model') === 'whisper-1' && form.get('response_format') === 'verbose_json' && auth === 'Bearer oa',
      'OpenAI 請求帶 whisper-1、verbose_json、Bearer 認證');
    const segs = d.segments || [];
    expect(segs.length === 1 && segs[0].en === 'Hamilton is closing the gap.' && segs[0].zh === '漢米爾頓正在縮小差距。',
      '不是講話（no_speech_prob 0.9）與「Please subscribe」被丟掉；單句走 translateOne 仍對得上', segs);
  }

  // ---- 5c. 兩個都有時優先 Deepgram ----
  {
    const env = baseEnv(); env.OPENAI_API_KEY = 'oa'; env.DEEPGRAM_API_KEY = 'dg'; cacheStore.clear(); calls.length = 0;
    fetchImpl = async (url) => (url.startsWith('https://api.deepgram.com/')
      ? jsonRes({ results: { channels: [{ alternatives: [{ transcript: 'Box box.', words: [{ start: 1, end: 1.4 }] }] }] } })
      : anthropic('進站、進站。'));
    const r = await call(env, wav(5), 'k-test-123');
    const s = (r.data && r.data.segments) || [];
    expect(r.data && r.data.provider === 'deepgram' && !calls.some((u) => /openai/.test(u)), '兩個金鑰都有時用 Deepgram');
    expect(s.length === 1 && s[0].start === 1 && s[0].end === 1.5, '沒有 utterances 時退回整段 transcript，時間取字詞首尾（最短 0.5 秒）', s);
  }

  // ---- 5d. 收割模式：?translate=0&words=1 ----
  {
    const env = baseEnv(); env.DEEPGRAM_API_KEY = 'dg'; cacheStore.clear(); calls.length = 0;
    fetchImpl = async (url) => {
      if (url.startsWith('https://api.deepgram.com/')) {
        return jsonRes({ results: {
          channels: [{ alternatives: [{ transcript: 'x', words: [
            { word: 'verstappen', punctuated_word: 'Verstappen', start: 0.1, end: 0.5, confidence: 0.9 },
            { word: 'pits', punctuated_word: 'pits.', start: 0.6, end: 0.9, confidence: 0.9 },
            { word: 'thank', punctuated_word: 'Thank', start: 2.0, end: 2.2, confidence: 0.9 },
            { word: 'you', punctuated_word: 'you.', start: 2.3, end: 2.5, confidence: 0.9 },
            { word: 'mumble', punctuated_word: 'mumble', start: 3.0, end: 3.2, confidence: 0.1 },
          ] }] }],
          utterances: [
            { start: 0.1, end: 0.9, transcript: 'Verstappen pits.', confidence: 0.9 },
            { start: 2.0, end: 2.5, transcript: 'Thank you.', confidence: 0.9 },
          ],
        } });
      }
      throw new Error('收割模式不該呼叫翻譯：' + url);
    };
    const r = await call(env, wav(5), 'k-test-123', '?translate=0&words=1');
    const d = r.data || {};
    expect(r.status === 200 && !calls.some((u) => /anthropic/.test(u)), '?translate=0：只辨識，不呼叫翻譯（收割時整份收完再翻）', calls);
    expect(Array.isArray(d.words) && d.words.map((w) => w.w).join(' ') === 'Verstappen pits.',
      '?words=1：回傳帶標點的逐字時間；幻覺句「Thank you.」與低信心的字不在裡面', d.words);
    expect(d.words && d.words[0].start === 0.1 && d.words[0].end === 0.5, '逐字時間保留原始秒數', d.words && d.words[0]);
    const r2 = await call(env, wav(5), 'k-test-123', '?translate=0');
    expect(r2.data && r2.data.words === undefined, '沒有要 words 時不回（即時模式的回應不變大）');
  }

  // ---- 5e. 整份翻譯 /v1/asr/test/translate ----
  {
    const treq = (body, key) => new Request('https://api.pitlingo.com/v1/asr/test/translate', {
      method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, key ? { 'x-asr-key': key } : {}), body: JSON.stringify(body),
    });
    const tcall = async (env, body, key) => {
      const r = await A.handleAsrTranslate(treq(body, key), env);
      return { status: r.status, data: JSON.parse(await r.text()) };
    };
    calls.length = 0;
    const noEnv = baseEnv(); delete noEnv.ASR_TEST_KEY;
    const n1 = await tcall(noEnv, { lines: ['a b'] }, 'k-test-123');
    const n2 = await tcall(baseEnv(), { lines: ['a b'] }, 'wrong');
    expect(n1.status === 404 && n2.status === 404 && !calls.length, '整份翻譯：沒設金鑰或金鑰錯誤 → 404，不呼叫模型');
    const big = await tcall(baseEnv(), { lines: Array.from({ length: A.ASR_TRANSLATE_MAX_LINES + 1 }, (_, i) => 'line ' + i) }, 'k-test-123');
    const empty = await tcall(baseEnv(), { lines: [] }, 'k-test-123');
    const long = await tcall(baseEnv(), { lines: ['x'.repeat(1001)] }, 'k-test-123');
    expect(big.status === 413 && empty.status === 400 && long.status === 400 && !calls.length, '整份翻譯：超過上限 413、空的或過長 400，都不呼叫模型');

    let prompt = '';
    fetchImpl = async (url, init) => {
      prompt = JSON.parse(init.body).messages[0].content;
      return jsonRes({ stop_reason: 'end_turn', content: [{ type: 'text', text: '1. 維斯塔潘進站。\n2. 抱歉，我無法翻譯這句，請提供更多上下文。\n3. 諾里斯留在賽道上。' }],
        usage: { input_tokens: 1000, output_tokens: 200 } });
    };
    const before = JSON.stringify(A.statsSnapshot());
    const ok = await tcall(baseEnv(), { lines: ['Verstappen pits.', 'Leclerc  has DRS.', 'Norris stays out.'] }, 'k-test-123');
    const o = ok.data.out || [];
    expect(ok.status === 200 && o.length === 3 && o[0].zh === '維斯塔潘進站。' && o[2].zh === '諾里斯留在賽道上。', '整份翻譯：依順序回每一句', o);
    expect(o[1] && o[1].zh === '' && o[1].en === 'Leclerc has DRS.', '整份翻譯：模型的自言自語被守門擋下；多餘空白收斂', o[1]);
    expect(/1\. Verstappen pits\.\n2\. Leclerc has DRS\.\n3\. Norris stays out\./.test(prompt), '三句放同一批送（模型看得到前後文）', prompt);
    expect(ok.data.usd > 0, '回傳這批的翻譯成本', ok.data.usd);
    const after = A.statsSnapshot();
    expect(JSON.stringify(after) !== before && after.rows && after.rows['asr-test'] && after.rows['asr-test'].in >= 1000,
      '翻譯用量記進成本統計（熔斷與後台算得到）', after.rows && after.rows['asr-test']);
  }

  // ---- 6. 幻覺正則不可以誤殺正常句 ----
  {
    const legit = ['Thank you, Lando, for letting me by.', 'You have to box this lap.', 'Okay, understood, pushing now.'];
    const killed = legit.filter((x) => A.ASR_HALLUCINATION.test(x));
    expect(!killed.length, '幻覺過濾不會誤殺含 thank you／you／okay 的正常句', killed);
  }

  // ---- 7. 後端回出去的每一個錯誤碼都要在代碼表裡（後台「問題回報」查得到）----
  {
    const raw = readBackend();
    const start = raw.indexOf('const ERR_CODES = {');
    const table = raw.slice(start, raw.indexOf('\n};', start));
    const used = [...new Set([...raw.matchAll(/code: '(E\d\d)'|, '(E\d\d)'\)/g)].map((m) => m[1] || m[2]))];
    const missing = start < 0 ? ['找不到 ERR_CODES'] : used.filter((code) => !new RegExp('\\b' + code + ':').test(table));
    expect(!missing.length, `後端回出去的 ${used.length} 個錯誤碼都在代碼表裡`, missing.join('、'));
  }

  console.log('');
  if (failed) { console.log(`❌ 語音辨識測試端點有 ${failed} 項未通過`); process.exit(1); }
  console.log('✅ 語音辨識測試端點全部通過');
})().catch((e) => { console.log('❌ 執行失敗：' + (e && e.stack || e)); process.exit(1); });
