import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// 函数最长执行时间（秒）
export const config = { maxDuration: 60 };

/* ============================================================
 * modelConfigMap：所有模型配置集中在这里
 * 以后加模型只需要加一项配置，主调用代码完全不用改
 * 密钥一律读环境变量，代码里不写死
 * ============================================================ */
const modelConfigMap = {
  doubao: {
    label: '豆包 · 火山方舟',
    baseURL: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey:
      process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.AI_API_KEY || '',
    model: process.env.DOUBAO_MODEL || 'doubao-seed-1-6-250615',
    keyEnv: 'DOUBAO_API_KEY',
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  qwen: {
    label: '通义千问 · DashScope',
    baseURL: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    model: process.env.QWEN_MODEL || 'qwen-plus',
    keyEnv: 'QWEN_API_KEY',
  },
  kimi: {
    label: 'Kimi · 月之暗面',
    baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
    apiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '',
    model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
    keyEnv: 'KIMI_API_KEY',
  },
};

const DEFAULT_MODEL_KEY = process.env.DEFAULT_MODEL || 'doubao';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zhdqyidijojadrwiklna.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const TABLE = process.env.SUPABASE_TABLE || 'naming_records';

const SYSTEM_PROMPT = `你是一位精通汉语音韵、字义训诂与典籍出处的起名专家。
请根据用户给出的姓氏、性别倾向、风格与寓意需求，给出三组不同的名字方案。

硬性要求：
1. 正好三组方案，分别标注为「方案一」「方案二」「方案三」，每组一个新名字，不要重复。
2. 名字以 2 个字为主；用户限定字数时严格服从。避开生僻字、多音字、贬义谐音，与姓氏连读不能出现歧义或不良谐音。
3. 每组都要解释寓意，说清字的本义与引申义，以及为什么贴合用户的需求。
4. 出处必须是真实存在的诗文典籍；若没有确切出处，就写「无明确出处」，严禁编造。
5. 语气专业、克制，不夸张，不做命理、五行、吉凶之类的断言。

严格按以下格式输出，不要任何开场白、总结或额外说明：

## 方案一｜<名字>
- 拼音：<拼音>
- 寓意：<2-3 句，讲清字义与整体意涵>
- 出处：<典籍与原文，或「无明确出处」>
- 气质：<3 个关键词，用顿号分隔>

## 方案二｜<名字>
- 拼音：
- 寓意：
- 出处：
- 气质：

## 方案三｜<名字>
- 拼音：
- 寓意：
- 出处：
- 气质：`;

/* ---------------- 通用工具 ---------------- */

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function clean(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function publicModelList() {
  return Object.entries(modelConfigMap).map(([key, cfg]) => ({
    key,
    label: cfg.label,
    model: cfg.model,
    available: Boolean(cfg.apiKey),
    keyEnv: cfg.keyEnv,
  }));
}

// 把请求体拼成一段可读的起名需求（同时用于入库）
function buildRequirement(body) {
  const surname = clean(body.surname, 4);
  const gender = clean(body.gender, 10);
  const styles = Array.isArray(body.styles) ? body.styles.map((s) => clean(s, 20)).filter(Boolean) : [];
  const length = clean(body.length, 10);
  const meaning = clean(body.meaning, 300);
  const extra = clean(body.extra, 200);

  if (!surname && !meaning && !extra && !styles.length) return '';

  const parts = [];
  if (surname) parts.push(`姓氏：${surname}`);
  if (gender) parts.push(`性别倾向：${gender}`);
  if (styles.length) parts.push(`风格偏好：${styles.join('、')}`);
  if (length) parts.push(`字数要求：${length}`);
  if (meaning) parts.push(`期望寓意：${meaning}`);
  if (extra) parts.push(`补充要求：${extra}`);
  return parts.join('；');
}

// 从模型输出里解析出三组方案，用于写库和历史展示
function parsePlans(text) {
  const heads = [...text.matchAll(/^#{2,3}\s*方案[一二三四五六1-6][^\n]*$/gm)];
  const table = ['一', '二', '三', '四', '五', '六'];

  return heads.map((head, i) => {
    const start = head.index + head[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const detail = text.slice(start, end).trim();

    const title = head[0]
      .replace(/^#{2,3}\s*/, '')
      .replace(/^方案[一二三四五六1-6]\s*/, '')
      .replace(/^[｜|:：\-—]\s*/, '')
      .trim();

    const name = (title.split(/[｜|\s（(]/)[0] || '').trim();

    return { label: `方案${table[i] || i + 1}`, name, detail };
  });
}

/* ============================================================
 * 一套共用调用代码：适配 modelConfigMap 里的任意模型
 * 四家平台都是 OpenAI 兼容协议：同一个路径、同一个鉴权头、同一种 SSE 结构
 * ============================================================ */
async function* streamChat(cfg, messages, signal, stats) {
  const response = await fetch(`${trimSlash(cfg.baseURL)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      stream: true,
      temperature: 0.85,
      messages,
    }),
    signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`模型接口返回 ${response.status}：${detail.slice(0, 300) || '无响应体'}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = function* (block) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) stats.usage = json.usage;

      const text = json.choices?.[0]?.delta?.content || '';
      if (text) {
        stats.chars += text.length;
        yield text;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      yield* consume(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* consume(buffer);
}

/* ---------------- 历史记录 ---------------- */

async function readHistory(limit) {
  if (!SUPABASE_KEY) return { records: [], error: '未配置 Supabase 密钥' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { records: [], error: error.message };
  return { records: data || [], error: null };
}

/* ---------------- 接口主流程 ---------------- */

export default async function handler(req, res) {
  /* ---- GET：模型列表 / 历史记录 ---- */
  if (req.method === 'GET') {
    const query = req.query || {};

    if (query.history) {
      const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 30);
      const { records, error } = await readHistory(limit);
      return res.status(200).json({ records, error });
    }

    const models = publicModelList();
    const fallback = models.find((m) => m.available)?.key || null;
    return res.status(200).json({
      models,
      defaultModel: models.some((m) => m.key === DEFAULT_MODEL_KEY && m.available)
        ? DEFAULT_MODEL_KEY
        : fallback,
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: '仅支持 GET / POST 请求' });
  }

  /* ---- POST：起名 ---- */
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const requirement = buildRequirement(body);

  if (!requirement) {
    return res.status(400).json({ error: '请至少填写姓氏、风格或期望寓意中的一项' });
  }
  if (requirement.length > 600) {
    return res.status(400).json({ error: '需求内容过长，请精简到 600 字以内' });
  }

  const modelKey = clean(body.model, 20) || DEFAULT_MODEL_KEY;
  const cfg = modelConfigMap[modelKey];

  if (!cfg) {
    return res.status(400).json({ error: `未知的模型：${modelKey}` });
  }
  if (!cfg.apiKey) {
    return res.status(500).json({
      error: `模型「${cfg.label}」未配置密钥，请设置环境变量 ${cfg.keyEnv}`,
    });
  }

  const startedAt = Date.now();
  const abort = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) abort.abort();
  });

  /* ---- 建立 SSE 通道 ---- */
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    if (finished || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  res.write(': connected\n\n');

  /* ---- 入库：先落一条 streaming 记录，拿 id ---- */
  let supabase = null;
  let recordId = null;

  if (SUPABASE_KEY) {
    try {
      supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
      const { data, error } = await supabase
        .from(TABLE)
        .insert({ requirement, model: cfg.model, provider: modelKey, status: 'streaming' })
        .select('id')
        .single();

      if (error) send('warning', { message: `起名记录初始化失败：${error.message}` });
      else recordId = data.id;
    } catch (err) {
      send('warning', { message: `Supabase 连接异常：${err.message}` });
    }
  } else {
    send('warning', { message: '未配置 Supabase 密钥，本次结果不会写库' });
  }

  send('meta', {
    model: cfg.model,
    provider: modelKey,
    providerLabel: cfg.label,
    recordId,
  });

  /* ---- 流式生成 ---- */
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `起名需求：${requirement}\n\n请按约定格式输出三组方案。` },
  ];

  let output = '';
  const stats = { usage: null, chars: 0 };

  try {
    for await (const text of streamChat(cfg, messages, abort.signal, stats)) {
      output += text;
      send('delta', { text });
    }
  } catch (err) {
    if (abort.signal.aborted) {
      finished = true;
      if (!res.writableEnded) res.end();
      return;
    }

    const cause = err.cause && (err.cause.message || err.cause.code);
    const message = cause ? `${err.message || '请求失败'}（${cause}）` : err.message || '生成失败';

    send('error', { message });
    if (supabase && recordId) {
      await supabase
        .from(TABLE)
        .update({
          status: 'failed',
          error_message: message.slice(0, 500),
          latency_ms: Date.now() - startedAt,
        })
        .eq('id', recordId)
        .then(() => null, () => null);
    }
    finished = true;
    if (!res.writableEnded) res.end();
    return;
  }

  /* ---- 收尾：解析、写库、结束 ---- */
  const plans = parsePlans(output);
  const latency = Date.now() - startedAt;

  if (supabase && recordId) {
    const { error } = await supabase
      .from(TABLE)
      .update({
        names: plans,
        raw_output: output,
        status: 'success',
        token_usage: stats.usage,
        latency_ms: latency,
      })
      .eq('id', recordId);

    if (error) send('warning', { message: `结果写库失败：${error.message}` });
  }

  send('done', {
    recordId,
    model: cfg.model,
    provider: modelKey,
    providerLabel: cfg.label,
    plans,
    latency,
  });
  finished = true;
  if (!res.writableEnded) res.end();
}
