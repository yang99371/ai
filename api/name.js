/**
 * POST /api/name
 * 多模型起名接口：一套共用调用代码，支持 doubao / deepseek / qwen / kimi 切换
 *
 * 流程：校验入参 -> 按 modelKey 取 modelConfigMap -> 统一构建请求（responses / chat 两种协议）
 *      -> 流式转发正文增量 -> 流结束后把「需求 + 方案 + 模型」写入 Supabase
 *
 * 环境变量（Vercel → Settings → Environment Variables，或用根目录 .env）：
 *   DOUBAO_API_KEY    方舟 Key（豆包用；deepseek / kimi 走方舟时也复用它）
 *   DASHSCOPE_API_KEY 阿里云百炼 Key（qwen 默认走百炼 OpenAI 兼容接口）
 *   每个 provider 还可被 <PROVIDER>_API_KEY / <PROVIDER>_BASE_URL / <PROVIDER>_MODEL /
 *   <PROVIDER>_API 覆盖，例如 KIMI_BASE_URL=https://api.moonshot.cn/v1
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / SUPABASE_TABLE
 */

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_TABLE = 'name_records';
const DEFAULT_MODEL_KEY = 'doubao';

/**
 * 1) 模型配置表：新增模型只在这里加一条，调用代码不用动
 *    gateway    : 'ark' | 'dashscope'，仅用于把报错翻译成对应控制台的提示
 *    api        : 'responses'（方舟 Responses API）| 'chat'（OpenAI 兼容 chat/completions）
 *    apiKeyEnvs : 按顺序取第一个存在的环境变量
 */
const MODEL_CONFIG_MAP = {
  doubao: {
    key: 'doubao',
    label: '豆包 Seed 2.1 Pro',
    provider: 'doubao',
    gateway: 'ark',
    api: 'responses',
    baseUrl: ARK_BASE,
    model: 'doubao-seed-2-1-pro-260915',
    apiKeyEnvs: ['DOUBAO_API_KEY', 'ARK_API_KEY', 'VOLC_API_KEY'],
    envPrefix: 'DOUBAO',
  },
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek V4.1 Flash',
    provider: 'deepseek',
    gateway: 'ark',
    api: 'responses',
    baseUrl: ARK_BASE,
    model: 'deepseek-v4-1-flash-261017',
    apiKeyEnvs: ['DEEPSEEK_API_KEY', 'DOUBAO_API_KEY', 'ARK_API_KEY', 'VOLC_API_KEY'],
    envPrefix: 'DEEPSEEK',
  },
  qwen: {
    key: 'qwen',
    label: '通义千问 Plus',
    provider: 'qwen',
    gateway: 'dashscope',
    api: 'chat',
    baseUrl: DASHSCOPE_BASE,
    model: 'qwen-plus',
    apiKeyEnvs: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'ALIYUN_API_KEY'],
    envPrefix: 'QWEN',
  },
  kimi: {
    key: 'kimi',
    label: 'Kimi K3.1 Pro',
    provider: 'kimi',
    gateway: 'ark',
    api: 'responses',
    baseUrl: ARK_BASE,
    model: 'kimi-k3-1-pro-261024',
    apiKeyEnvs: ['KIMI_API_KEY', 'MOONSHOT_API_KEY', 'DOUBAO_API_KEY', 'ARK_API_KEY'],
    envPrefix: 'KIMI',
  },
};

const SYSTEM_PROMPT = `你是一位资深中文命名顾问，擅长人名、品牌名、商标名、项目名、店铺名、宠物名的创意与释义。

输出规则：
1. 严格给出 3 组方案，每组 1 个主推名字；如名字有歧义或多音字，可再给 1 个备选写法。
2. 三组之间风格必须有明显区分，并在小标题里点明风格（例如：典雅古风 / 现代简洁 / 谐音趣味）。
3. 每组都写清楚：名字、寓意（构词来源、意象、字义拆解、读音与气质），不要空泛抒情。
4. 使用 Markdown 输出，格式固定为：

### 方案1 · <风格标签>
**名字**：xxx
**寓意**：xxx

### 方案2 · <风格标签>
**名字**：xxx
**寓意**：xxx

### 方案3 · <风格标签>
**名字**：xxx
**寓意**：xxx

**一句话建议**：xxx

5. 不要寒暄、不要重复用户需求、不要输出与起名无关的内容；如果用户需求过于模糊（例如只写"起个名"），按最常见的场景给出通用方案并在开头一行用"猜你想"简短说明你的假设。`;

/** 统一的 SSE 写包 */
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 2) 解析模型配置：静态表 + 环境变量覆盖 */
function resolveModelConfig(modelKey) {
  const base = MODEL_CONFIG_MAP[modelKey];
  if (!base) return null;

  const prefix = base.envPrefix;

  return {
    ...base,
    api: String(process.env[`${prefix}_API`] || base.api).toLowerCase(),
    baseUrl: String(process.env[`${prefix}_BASE_URL`] || base.baseUrl).replace(/\/+$/, ''),
    model: process.env[`${prefix}_MODEL`] || base.model,
    apiKey: pickEnv(base.apiKeyEnvs),
    apiKeyFrom: base.apiKeyEnvs.find((n) => process.env[n]) || null,
  };
}

function pickEnv(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return '';
}

/** 3) 共用调用代码：两种协议只在这一个函数里分流 */
function buildRequest(cfg, requirement) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: requirement },
  ];

  if (cfg.api === 'chat') {
    return {
      url: `${cfg.baseUrl}/chat/completions`,
      body: { model: cfg.model, stream: true, messages },
    };
  }

  return {
    url: `${cfg.baseUrl}/responses`,
    body: { model: cfg.model, stream: true, input: messages },
  };
}

/** 从各家流式事件里取出正文增量：responses / chat.completions 都兼容 */
function extractDelta(obj) {
  if (!obj || typeof obj !== 'object') return '';
  // responses API：{ type: 'response.output_text.delta', delta: '...' }
  if (typeof obj.type === 'string') {
    if (obj.type !== 'response.output_text.delta') return '';
    return typeof obj.delta === 'string' ? obj.delta : '';
  }
  // chat.completions（豆包 / DeepSeek / 千问 / Kimi 通用）
  const choice = obj.choices && obj.choices[0];
  if (choice && choice.delta && typeof choice.delta.content === 'string') {
    return choice.delta.content;
  }
  return '';
}

/** 把上游错误翻译成可直接照做的中文提示 */
function explainUpstreamError(status, detail, cfg) {
  const text = String(detail || '');
  let code = '';
  try {
    const parsed = JSON.parse(text);
    code = (parsed && parsed.error && parsed.error.code) || '';
  } catch (_) {
    /* 非 JSON，忽略 */
  }

  const where = cfg.gateway === 'dashscope' ? '阿里云百炼控制台' : '火山方舟控制台';

  if (code === 'ModelNotOpen' || text.includes('ModelNotOpen')) {
    return {
      code: code || 'ModelNotOpen',
      message: `「${cfg.label}」未开通：当前账号没有开通「${cfg.model}」。请到${where}的开通管理中开通该模型，或把环境变量 ${cfg.envPrefix}_MODEL 换成已开通的模型。`,
    };
  }
  if (code === 'InvalidEndpointOrModel.NotFound' || text.includes('InvalidEndpointOrModel')) {
    return {
      code: code || 'InvalidEndpointOrModel',
      message: `「${cfg.label}」模型名无效或当前账号无权访问：请检查 ${cfg.envPrefix}_MODEL=「${cfg.model}」，或让 ${cfg.envPrefix}_BASE_URL 指向该模型所属网关。`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: 'AuthError',
      message: `「${cfg.label}」密钥无效或缺少权限：请检查环境变量 ${cfg.apiKeyEnvs.join(' / ')} 里的 Key。`,
    };
  }
  if (status === 429) {
    return {
      code: 'RateLimited',
      message: `「${cfg.label}」调用过于频繁或额度不足（429），请稍后重试或检查账号额度。`,
    };
  }
  if (status >= 500) {
    return {
      code: 'UpstreamError',
      message: `「${cfg.label}」上游服务异常（HTTP ${status}），稍后重试即可。`,
    };
  }
  return {
    code: code || `HTTP_${status}`,
    message: `「${cfg.label}」调用失败（HTTP ${status}），请查看技术详情。`,
  };
}

/** 4) 落库：失败只记日志，绝不影响已经流给用户的内容 */
async function saveToSupabase({ requirement, result, model }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const table = process.env.SUPABASE_TABLE || DEFAULT_TABLE;

  if (!url || !key) {
    return { saved: false, skipped: true, reason: '未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，已跳过落库' };
  }

  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/${table}`;
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify([{ requirement, result, model }]),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[supabase] insert failed:', resp.status, text);
      let reason = `Supabase 写入失败（HTTP ${resp.status}）`;
      if (resp.status === 401 || resp.status === 403 || /42501|row-level security/i.test(text)) {
        reason += '：被行级安全策略（RLS）拦截，请改用 SUPABASE_SERVICE_ROLE_KEY，或在表上放开 insert 策略（见 supabase.sql）';
      } else if (resp.status === 404) {
        reason += '：表不存在，请先在 Supabase SQL Editor 执行 supabase.sql 建表';
      }
      return { saved: false, reason };
    }

    let rows = [];
    try {
      rows = await resp.json();
    } catch (_) {
      /* return=representation 才有 body */
    }
    const record = Array.isArray(rows) ? rows[0] : rows;
    return { saved: true, id: record && record.id ? record.id : null };
  } catch (err) {
    console.error('[supabase] insert error:', err);
    return { saved: false, reason: `Supabase 写入异常：${err.message}` };
  }
}

/** GET /api/name：返回可选模型列表，供前端下拉框渲染 */
function listModelsPayload() {
  return {
    ok: true,
    defaultModelKey: DEFAULT_MODEL_KEY,
    models: Object.values(MODEL_CONFIG_MAP).map((m) => {
      const cfg = resolveModelConfig(m.key);
      return {
        key: m.key,
        label: m.label,
        provider: m.provider,
        api: cfg.api,
        model: cfg.model,
        ready: Boolean(cfg.apiKey),
        keyFrom: cfg.apiKeyFrom,
      };
    }),
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(listModelsPayload());
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: '只支持 GET / POST 请求' });
  }

  // 兼容 body 已解析 / 字符串 / 未解析的情况
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  }
  if (!body || typeof body !== 'object') body = {};

  const requirement = String(body.requirement || '').trim();
  if (!requirement) {
    return res.status(400).json({ ok: false, error: '请先填写起名需求' });
  }
  if (requirement.length > 800) {
    return res.status(400).json({ ok: false, error: '需求描述过长，请控制在 800 字以内' });
  }

  const modelKey = String(body.modelKey || DEFAULT_MODEL_KEY).trim();
  const cfg = resolveModelConfig(modelKey);
  if (!cfg) {
    return res.status(400).json({
      ok: false,
      error: `不支持的模型「${modelKey}」，可选：${Object.keys(MODEL_CONFIG_MAP).join(' / ')}`,
    });
  }

  if (!cfg.apiKey) {
    return res.status(500).json({
      ok: false,
      error: `「${cfg.label}」缺少密钥环境变量（${cfg.apiKeyEnvs.join(' 或 ')}），请在服务端配置后再试`,
    });
  }

  // ---- 开始流式响应 ----
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.status(200);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // 客户端中断检测：只能看 res 的 close，且必须排除“正常结束”的情况
  // （req 的 close 在请求体读完后就会触发，用它会被误判成断连，导致流式直接空转）
  let closed = false;
  res.on('close', () => {
    if (!res.writableEnded) closed = true;
  });

  sse(res, 'meta', {
    modelKey: cfg.key,
    provider: cfg.provider,
    label: cfg.label,
    model: cfg.model,
    api: cfg.api,
    startedAt: Date.now(),
  });

  const { url, body: upstreamBody } = buildRequest(cfg, requirement);
  console.log(`[model] ${cfg.key} -> ${url} model=${cfg.model} api=${cfg.api}`);

  let full = '';
  let usage = null;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(upstreamBody),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      console.error(`[${cfg.key}] upstream error:`, upstream.status, detail);
      const mapped = explainUpstreamError(upstream.status, detail, cfg);
      sse(res, 'error', {
        message: mapped.message,
        code: mapped.code,
        modelKey: cfg.key,
        detail: detail.slice(0, 400),
      });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (closed) {
        try {
          await reader.cancel();
        } catch (_) {}
        break;
      }

      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';

      for (const block of blocks) {
        let dataStr = '';
        for (const line of block.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) continue;
          if (!trimmed.startsWith('data:')) continue;
          const v = trimmed.slice(5).trim();
          if (v === '[DONE]') continue;
          dataStr += v;
        }
        if (!dataStr) continue;

        let obj;
        try {
          obj = JSON.parse(dataStr);
        } catch (_) {
          continue;
        }

        if (obj.usage) usage = obj.usage;
        if (obj.response && obj.response.usage) usage = obj.response.usage;

        const delta = extractDelta(obj);
        if (delta) {
          full += delta;
          sse(res, 'delta', { text: delta });
        }
      }
    }
  } catch (err) {
    console.error(`[${cfg.key}] stream error:`, err);
    sse(res, 'error', {
      message: `「${cfg.label}」流式输出中断：${err.message}`,
      code: 'StreamError',
      modelKey: cfg.key,
    });
    if (!closed) res.end();
    return;
  }

  // ---- 落库：model 字段记录「厂商/模型」，一张表即可区分多个模型 ----
  const modelTag = `${cfg.provider}/${cfg.model}`;
  let saved = { saved: false, skipped: true, reason: '生成内容为空，未落库' };
  if (full.trim()) {
    saved = await saveToSupabase({ requirement, result: full, model: modelTag });
  }

  sse(res, 'done', {
    modelKey: cfg.key,
    provider: cfg.provider,
    label: cfg.label,
    model: cfg.model,
    modelTag,
    chars: full.length,
    usage,
    saved: saved.saved === true,
    recordId: saved.id || null,
    warning: saved.saved ? null : saved.reason || null,
  });
  res.end();
};

// Vercel Node 函数配置：流式生成可能超过默认 10s，放宽到 60s
module.exports.config = {
  maxDuration: 60,
};

// 便于调试 / 单测时读取配置表
module.exports.MODEL_CONFIG_MAP = MODEL_CONFIG_MAP;
module.exports.resolveModelConfig = resolveModelConfig;
