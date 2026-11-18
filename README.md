# AI 起名馆（多模型版）

Vercel Node Function + Supabase 的 AI 起名站点：选择 models → 填写需求 → 模型流式输出三组名字与寓意 → 结果自动入库，历史记录可查。

## 目录结构

```
package.json          依赖（@supabase/supabase-js、dotenv）与 ESM 声明
.gitignore            排除 .env / node_modules / .vercel
index.html            前端页面（单文件，无构建步骤）
api/name.js           GET 模型列表/历史记录，POST 流式起名 + 入库
supabase/schema.sql   建表、索引、RLS 脚本
.env.example          环境变量模板
```

## 一、建表

Supabase 控制台 → SQL Editor → 执行 `supabase/schema.sql`，创建 `naming_records` 表并开启 RLS（脚本可重复执行，阶段 1 建过表也会补上 `provider` 字段）。

## 二、配置环境变量

本地写进 `.env`（已被 git 忽略），线上在 Vercel 控制台 Settings → Environment Variables 配同名变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DOUBAO_API_KEY` | 选填 | 火山方舟密钥，配了才出现在下拉框 |
| `DEEPSEEK_API_KEY` | 选填 | DeepSeek 密钥 |
| `QWEN_API_KEY` | 选填 | 通义千问 DashScope 密钥 |
| `KIMI_API_KEY` | 选填 | 月之暗面密钥 |
| `SUPABASE_URL` | 否 | 默认 `https://zhdqyidijojadrwiklna.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | 服务端写权限密钥，只放服务端 |
| `SUPABASE_ANON_KEY` | 否 | 没有 service_role 时的回退项 |

可选覆盖项：`DOUBAO_MODEL`、`DEEPSEEK_MODEL`、`QWEN_MODEL`、`KIMI_MODEL`、`DEFAULT_MODEL`（默认选中的模型 key）。

四家都是 OpenAI 兼容网关，所以只有一套调用代码：

| 模型 | baseURL |
| --- | --- |
| 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3` |
| DeepSeek | `https://api.deepseek.com/v1` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi | `https://api.moonshot.cn/v1` |

## 三、加一个新模型

只改 `api/name.js` 顶部的 `modelConfigMap`，加一项即可，前端下拉框和后端调用都不用动：

```js
newmodel: {
  label: '新模型',
  baseURL: process.env.NEWMODEL_BASE_URL || 'https://api.example.com/v1',
  apiKey: process.env.NEWMODEL_API_KEY || '',
  model: process.env.NEWMODEL_MODEL || 'default-model-name',
  keyEnv: 'NEWMODEL_API_KEY',
}
```

## 四、部署

```bash
git add .
git commit -m "feat: multi-model ai naming"
git push origin main
```

Vercel 导入仓库即可（纯静态页 + `api/` 函数，无需 Build Command），然后把上面那批环境变量填进 Vercel。

本地调试：

```bash
npm install
npx vercel dev
```

## 五、接口约定

**GET `/api/name`** → 模型列表

```json
{ "models": [{ "key": "doubao", "label": "豆包 · 火山方舟", "model": "doubao-seed-1-6-250615", "available": true, "keyEnv": "DOUBAO_API_KEY" }], "defaultModel": "doubao" }
```

**GET `/api/name?history=1&limit=10`** → 最近记录（服务端读库，不走匿名权限）

**POST `/api/name`** 请求体：

```json
{
  "model": "deepseek",
  "surname": "林",
  "gender": "女孩",
  "styles": ["文雅", "古风"],
  "length": "两个字（不含姓）",
  "meaning": "心胸开阔，出自山水诗文",
  "extra": "不要多音字"
}
```

响应为 `text/event-stream`：

| 事件 | 数据 | 说明 |
| --- | --- | --- |
| `meta` | `{ model, provider, providerLabel, recordId }` | 模型与记录 id |
| `delta` | `{ text }` | 增量文本 |
| `warning` | `{ message }` | 入库失败等非致命提示 |
| `error` | `{ message }` | 生成失败 |
| `done` | `{ recordId, model, provider, plans, latency }` | 结束，附解析结果 |

## 六、数据表 `naming_records`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 主键 |
| `requirement` | text | 用户需求 |
| `names` | jsonb | 解析出的方案 `[{label,name,detail}]` |
| `raw_output` | text | 模型原始输出 |
| `model` | text | 使用的模型，如 `deepseek-chat` |
| `provider` | text | 模型来源，如 `deepseek` |
| `status` | text | `streaming` / `success` / `failed` |
| `error_message` | text | 失败原因 |
| `token_usage` | jsonb | 接口返回的 usage |
| `latency_ms` | int | 生成耗时 |
| `created_at` / `updated_at` | timestamptz | 时间戳 |

## 注意事项

- 密钥只存在服务端环境变量里，`index.html` 不接触 Supabase，也不会泄露 service_role key。
- 页面用相对路径 `/api/name`，本地必须 `npx vercel dev`（直接双击 html 会 404）。
- 页面顶部的下拉框只列出已配置密钥的模型，未配置的显示为灰色不可选。
- 模型输出格式跑偏时 `names` 可能解析为空，但 `raw_output` 一定保留了完整结果。
