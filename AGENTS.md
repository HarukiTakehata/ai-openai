# AGENTS.md — 藍 (Ai) Bot for Misskey

> **ybw2016v/ai** fork — OpenAI 兼容 API 改造版

## 项目概要

蓝（Ai）是一个运行在去中心化社交平台 [Misskey](https://github.com/misskey-dev/misskey) 上的日语拟人化 Bot。它以「三須木藍」的角色身份与用户互动，提供 20+ 种互动功能（占卜、计时器、黑白棋、迷宫等）。本 fork 在原有基础上新增了 **OpenAI 兼容 API** 对话模块，支持 GPT-4/3.5、Ollama、vLLM、LM Studio 等任意兼容端点。

- **上游仓库**: [syuilo/ai](https://github.com/syuilo/ai)
- **本 fork**: 基于 v1.5.0，CommonJS 模块系统
- **语言**: TypeScript 5.3 → 编译为 ES2020 CommonJS
- **运行时**: Node.js 22（Docker 固定为 22.23.1）

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript 5.3 (`commonjs` 模块, `es2020` target) |
| 路径别名 | `module-alias` — `@/` → `built/`（运行时）, `src/`（编译时） |
| HTTP 客户端 | `request-promise-native` |
| WebSocket | `ws` + `reconnecting-websocket` |
| 数据库 | `lokijs`（内存 DB，每秒自动存入 `memory.json`） |
| 图像 | `node-canvas`（chart/maze 渲染） |
| 测试 | Jest 29 + ts-jest 29 |
| AI API | OpenAI 兼容 `/v1/chat/completions` |
| 形态素分析 | `nodejieba`（中文）/ MeCab（日语, 可选） |

---

## 目录结构

```
.
├── config.json            # 运行时配置（不需编译）
├── tsconfig.json          # 主 tsconfig
├── package.json           # + jest config
├── Dockerfile
├── docker-compose.yml
│
├── src/                   # === TypeScript 源码 ===
│   ├── index.ts           # 启动入口: 账号验证 → new 藍(account, modules[])
│   ├── ai.ts              # 核心类「藍」— 消息路由/上下文/定时器/DB
│   ├── stream.ts          # WebSocket 连接管理 (Shared/NonShared Pool)
│   ├── module.ts          # 抽象模块基类
│   ├── message.ts         # 消息封装 (Note/DM 统一接口)
│   ├── friend.ts          # 用户关系 + 亲爱度系统
│   ├── config.ts          # 配置类型 + config.json 加载
│   ├── serifs.ts          # 台词模板 (~500行)
│   ├── vocabulary.ts      # 随机物品名生成器
│   ├── misskey/           # Misskey 类型定义
│   │   ├── user.ts
│   │   └── note.ts
│   ├── utils/             # 工具函数
│   │   ├── includes.ts    # 文本多词匹配
│   │   ├── or.ts          # 正则+字符串匹配
│   │   ├── log.ts
│   │   ├── get-date.ts
│   │   ├── japanese.ts
│   │   ├── acct.ts
│   │   └── safe-for-interpolate.ts
│   └── modules/           # === 功能模块 (插件) ===
│       ├── openai/        # ★ OpenAI 兼容对话 (本 fork 新增)
│       ├── core/          # 称呼设定、记忆引继、版本
│       ├── aichat/        # (未启用) 上游 Gemini/PLaMo 对话
│       ├── talk/          # 闲聊反应
│       ├── reversi/       # 黑白棋对局
│       ├── maze/          # 迷宫生成
│       ├── dice/          # 骰子
│       ├── fortune/       # 占卜
│       ├── timer/         # 计时器
│       ├── reminder/      # 提醒
│       ├── keyword/       # 关键词学习
│       ├── chart/         # 实例图表
│       ├── server/        # 服务器监控
│       ├── welcome/       # 新人欢迎
│       ├── birthday/      # 生日祝福
│       ├── valentine/     # 情人节
│       ├── follow/        # 关注管理
│       ├── emoji/         # 颜文字组合
│       ├── emoji-react/   # emoji 反应
│       ├── noting/        # 随机发言
│       ├── poll/          # 投票
│       ├── ping/          # 生存确认
│       ├── guessing-game/ # 猜数字
│       ├── kazutori/      # 数取り
│       └── sleep-report/  # 睡眠报告
│
├── test/                  # === 测试 ===
│   ├── tsconfig.json      # 测试专用 tsconfig (sourceMap: true)
│   ├── openai.ts          # OpenAI 模块单元测试 (32 tests)
│   ├── core.ts            # 核心测试 (预存, 不完整)
│   ├── __mocks__/         # Jest mocks
│   │   ├── account.ts
│   │   ├── ws.ts
│   │   └── misskey.ts
│   └── __modules__/       # 测试用模块
│       └── test.ts
│
└── built/                 # === 编译产物 (tsc 输出) ===
    └── ... (与 src/ 同构)
```

---

## 开发命令

```bash
# 安装依赖
npm ci --legacy-peer-deps

# 编译
npm run build          # → tsc，输出到 built/

# 类型检查（不产出）
npx tsc --noEmit

# 运行
npm start              # → node ./built

# 测试
npm test               # → jest
npx jest test/openai.ts --no-coverage  # 只跑 OpenAI 测试
```

---

## 配置 (`config.json`)

必需字段：

```json
{
  "host": "https://your-misskey.example.com",
  "i": "BOT_ACCESS_TOKEN",
  "master": "ADMIN_USERNAME",
  "memoryDir": "data"
}
```

OpenAI 模块字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `openaiEnabled` | boolean | false | 启用 OpenAI 模块；必须显式设为 `true` |
| `openaiApiKey` | string | — | API 密钥（启用模块时必填） |
| `openaiBaseUrl` | string | `https://api.openai.com/v1` | 兼容端点（Ollama: `http://localhost:11434/v1`） |
| `openaiModel` | string | `gpt-4o-mini` | 模型名 |
| `openaiSystemPrompt` | string | 内置日语 prompt | 系统提示词 |
| `openaiMaxTokens` | number | 2800 | 最大输出 token |
| `openaiTemperature` | number | 0.7 | 温度 |
| `openaiRequestTimeoutMs` | number | 60000 | 模型请求超时（毫秒） |
| `openaiFileDownloadTimeoutMs` | number | 10000 | 附件下载超时（毫秒） |
| `openaiMaxAttachmentBytes` | number | 5242880 | 单附件大小上限 |
| `openaiMaxAttachments` | number | 2 | 单次图片附件数量上限 |
| `openaiMaxInputChars` | number | 12000 | 提示词与文本历史字符上限 |
| `openaiRateLimitPerMinute` | number | 3 | 每用户每分钟请求上限 |
| `openaiMaxConcurrentRequests` | number | 2 | 全局并发请求上限 |
| `openaiDailyRequestLimit` | number | 100 | UTC 日全局请求上限 |
| `openaiAllowedUserIds` | string[] | 未设置 | 可选 Misskey 用户 ID 白名单 |

---

## 架构核心概念

### 1. 模块系统 (Plugin)

所有功能都是 `Module` 的子类：

```typescript
export default class extends Module {
  public readonly name = 'my-module';

  public install() {
    return {
      mentionHook: this.mentionHook,    // 被 @ 时调用
      contextHook: this.contextHook,    // 有活跃上下文时调用
      timeoutCallback: this.timeoutCallback, // 定时器到期
    };
  }
}
```

- **优先级** = 在 `index.ts` 中注册顺序（先注册先匹配）
- `mentionHook` 返回 `true` 阻止后续模块处理
- `contextHook` 用于多轮对话（subscribeReply → unsubscribeReply）

### 2. 核心引擎 (`ai.ts` — `class 藍`)

```
消息流:
  WebSocket event → ai.ts handler → Message 封装 → 模块钩子

关键方法:
  api(endpoint, params)       → POST /api/{endpoint}
  post(params)                → 发帖 (notes/create)
  sendMessage(userId, params) → 发私信 (messaging/messages/create)
  upload(file, meta)           → 上传文件到 Drive
  subscribeReply(module, key, isDm, id, data)  → 等待回复
  setTimeoutWithPersistence(module, delay, data) → 持久化定时器
```

### 3. 上下文系统 (Context)

用于多轮对话状态管理：

```
1. mentionHook 触发
2. handleChat 处理 → 发回复
3. subscribeReply(msg.userId, isDm, replyId)  → 注册上下文
4. 用户回复 → contextHook 触发 → 继承 history → 再次 subscribeReply
5. 30分钟无回复 → timeoutCallback → 清理
```

### 4. 数据持久化 (LokiJS)

```
memory.json (自动保存, 1秒间隔)
├── meta          — {lastWakingAt}
├── contexts      — 活跃会话 (按 key 索引)
├── timers        — 持久化定时器 (按 module 索引)
├── friends       — 用户数据 (按 userId 索引)
│   └── {love, name, perModulesData, married, ...}
├── moduleData    — 模块私有数据
├── openaiSessions — OpenAI 模块会话记录
└── openaiUsage    — OpenAI 每日全局请求计数
```

### 5. WebSocket 连接池 (`stream.ts`)

```
Stream
├── SharedConnection (引用计数)
│   └── Pool: 引用计数 0 → 3秒后自动断开
├── NonSharedConnection (独占)
└── 断线自动重连 + 缓冲重发
```

---

## 编写新模块指南

```typescript
import autobind from 'autobind-decorator';
import Module from '@/module';
import Message from '@/message';
import config from '@/config';

export default class extends Module {
  public readonly name = 'my-module';  // 必须唯一

  @autobind
  public install() {
    // 在此初始化持久化集合、定时器等
    return {
      mentionHook: this.mentionHook,
      contextHook: this.contextHook,
      timeoutCallback: this.timeoutCallback,
    };
  }

  @autobind
  private async mentionHook(msg: Message): Promise<boolean> {
    if (!msg.includes(['触发词'])) return false;  // 不匹配则让给后面的模块
    // 处理逻辑...
    msg.reply('回复内容');
    return true;  // true = 已处理，阻止后续模块
  }

  @autobind
  private async contextHook(key: any, msg: Message, data?: any) {
    // 多轮对话逻辑
    this.unsubscribeReply(key);  // 取消旧订阅
    // ... 处理 ...
    this.subscribeReply(msg.userId, msg.isDm, newId, newData);  // 新订阅
    return { reaction: 'like' };
  }

  @autobind
  private timeoutCallback(data: any) {
    // 超时清理
  }
}
```

### Message 对象

| 属性 | 说明 |
|------|------|
| `msg.text` | 原始文本 |
| `msg.extractedText` | 去除 @mention 后的文本 |
| `msg.user` / `msg.userId` | 发送者 |
| `msg.isDm` | 是否为私信 |
| `msg.replyId` | 被回复的 Note ID（公开帖） |
| `msg.quoteId` | 被引用 Renote 的 ID |
| `msg.friend` | Friend 对象（亲爱度/称呼） |
| `msg.includes(words)` | 检查文本是否包含任一关键词 |
| `msg.reply(text, opts?)` | 回复此消息 |

---

## 代码约定

- **使用 `@autobind`** 而非上游的 `@bindThis`
- **CommonJS 风格 import**：`import * as X from 'y'` + `require()` 混用
- **路径别名**：源码 `@/` 编译到 `built/`，测试中 `#/` 指向 `test/`
- **配置**：通过 `import config from '@/config'` 访问
- **日志**：`this.log('...')` → `[moduleName]: ...` 格式
- **持久化**：模块需存储数据时用 `this.ai.getCollection('name')`
- **测试 mock**：`jest.mock('@/config', ...)` 需包含 `__esModule: true, default: {...}`

---

## 测试

- 测试文件放在 `test/`，通过 `npm test` 运行
- 使用 `jest.mock('@/config', ...)` 模拟配置
- 使用 `jest.mock('request-promise-native', ...)` 模拟 HTTP
- 模块实例化在测试中可用简化 mock AI 对象，无需完整 `new 藍()`
- 参考 `test/openai.ts` 作为测试范本

---

## 注意事项

1. **`config.json` 不参与编译** — 运行时由 `require()` 直接加载
2. **`module-alias`** 在 `index.ts` 第一行注册，确保在所有 import 之前生效
3. **LokiJS** 的 `autoloadCallback` 是异步的，DB 未加载完时不能操作 collection
4. **WebSocket** 依赖真实 Misskey 服务器，本地测试需 mock
5. 原版上游是 ESM + `got`，本 fork 是 CJS + `request-promise-native`，API 风格不同
6. OpenAI 模块的 `extractFiles()` 只处理图片类型文件（vision 格式）
7. 会话历史限制 10 轮（20 条消息），防止 token 爆炸
