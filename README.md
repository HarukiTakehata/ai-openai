<h1><p align="center"><img src="./ai.svg" alt="藍" height="200"></p></h1>
<p align="center">An Ai for Misskey — OpenAI 兼容 API 版　<a href="./torisetu.md">使用说明</a>　<a href="./AGENTS.md">开发文档</a></p>

## 这是什么？

这是方便 Misskey 使用的日语 Bot（本 fork 为中文优化 + **OpenAI 兼容 API 改造**）。

**主要改动：**
- 🆕 **OpenAI 兼容 API 对话模块** — 替换上游 Gemini/PLaMo，支持 OpenAI / Azure / Ollama / vLLM / LM Studio 等任意 `/v1/chat/completions` 兼容端点
- 🇨🇳 **jieba 中文分词** — 将 MeCab 替换为 [nodejieba](https://github.com/yanyiwu/nodejieba)，更适合中文环境

> 基于 [ybw2016v/ai](https://github.com/ybw2016v/ai) (v1.5.0)，上游原版 [syuilo/ai](https://github.com/syuilo/ai)

## 安装

> 本地运行建议使用 Node.js 22；Docker 镜像固定为 Node.js 22.23.1。

```bash
git clone https://github.com/HarukiTakehata/ai-openai.git
cd ai-openai
```

创建 `config.json`（完整示例见下方），然后：

```bash
npm ci --legacy-peer-deps
npm run build
npm start
```

### Docker

```bash
docker-compose build
docker-compose up
```

## 配置 (`config.json`)

```json
{
  "host": "https:// + 您的实例 URL（末尾不加 /）",
  "i": "Bot 账号的 Access Token",
  "master": "管理员用户名（可选）",
  "notingEnabled": true,
  "keywordEnabled": false,
  "chartEnabled": false,
  "reversiEnabled": true,
  "serverMonitoring": false,
  "memoryDir": "data",

  "openaiEnabled": true,
  "openaiApiKey": "sk-your-api-key",
  "openaiBaseUrl": "https://api.openai.com/v1",
  "openaiModel": "gpt-4o-mini",
  "openaiSystemPrompt": "あなたはMisskey看板娘の女の子AI、藍として振る舞ってください...",
  "openaiMaxTokens": 2800,
  "openaiTemperature": 0.7,
  "openaiRequestTimeoutMs": 60000,
  "openaiFileDownloadTimeoutMs": 10000,
  "openaiMaxAttachmentBytes": 5242880,
  "openaiMaxAttachments": 2,
  "openaiMaxInputChars": 12000,
  "openaiRateLimitPerMinute": 3,
  "openaiMaxConcurrentRequests": 2,
  "openaiDailyRequestLimit": 100
}
```

### OpenAI 配置项说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `openaiEnabled` | boolean | false | 启用 OpenAI 对话功能；只有显式设为 `true` 才会加载模块 |
| `openaiApiKey` | string | — | API 密钥（启用模块时必填） |
| `openaiBaseUrl` | string | `https://api.openai.com/v1` | API 端点。Ollama 用户填 `http://localhost:11434/v1` |
| `openaiModel` | string | `gpt-4o-mini` | 模型名称 |
| `openaiSystemPrompt` | string | 内置日语 prompt | 系统提示词 |
| `openaiMaxTokens` | number | 2800 | 最大输出 token |
| `openaiTemperature` | number | 0.7 | 生成温度 (0-2) |
| `openaiRequestTimeoutMs` | number | 60000 | 模型 API 请求超时（毫秒） |
| `openaiFileDownloadTimeoutMs` | number | 10000 | 附件下载超时（毫秒） |
| `openaiMaxAttachmentBytes` | number | 5242880 | 单个图片附件的最大字节数 |
| `openaiMaxAttachments` | number | 2 | 单次请求最多处理的图片数 |
| `openaiMaxInputChars` | number | 12000 | 当前提示词与文本历史的最大总字符数 |
| `openaiRateLimitPerMinute` | number | 3 | 每用户每分钟最多调用次数 |
| `openaiMaxConcurrentRequests` | number | 2 | 全局并发模型请求上限 |
| `openaiDailyRequestLimit` | number | 100 | 按 UTC 日期持久化的全局每日请求上限 |
| `openaiAllowedUserIds` | string[] | 未设置 | 可选的 Misskey 用户 ID 白名单；未设置时允许所有非 Bot 用户 |

OpenAI 对话只接受独立命令 `openai`、`ai` 或 `chat`，例如 `@ai openai 你好`。普通的占卜、骰子、计时器等消息不会因为 Bot 用户名中含有 `ai` 而被该模块拦截。回复 Bot 的模型答案可继续多轮对话；会话 30 分钟后自动清理。

图片附件仅允许 HTTP(S)，默认最多 2 个、每个 5 MiB。下载会拒绝重定向、私网/保留地址和不受支持的图片 MIME 类型。

### 使用 Ollama 等本地模型

```json
{
  "openaiBaseUrl": "http://localhost:11434/v1",
  "openaiModel": "qwen2.5:7b",
  "openaiApiKey": "ollama"
}
```

### 获取 API Key

- **OpenAI**: https://platform.openai.com/api-keys
- **Azure OpenAI**: 使用 Azure 端点 + API Key
- **Ollama**: 本地运行，key 填任意值即可

## 字体

部分功能需要字体。将字体文件放置在安装目录下，命名为 `font.ttf`。

## 记忆

藍使用 LokiJS 内存数据库保存记忆，以 `memory.json` 持久化到 `memoryDir` 目录。

## 测试

```bash
npm test                    # 全部测试
npx jest test/openai.ts     # 仅 OpenAI 模块测试 (32 项)
```

## 开源许可证

MIT

## Awards

<img src="./WorksOnMyMachine.png" alt="Works on my machine" height="120">
