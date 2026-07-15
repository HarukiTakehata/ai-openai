/**
 * OpenAI 模块单元测试
 *
 * 测试范围：
 * - buildRequestBody: 请求体构建
 * - buildMessages: 消息列表构建
 * - callOpenAI: API 调用（mock）
 * - fileToBase64: 文件下载转换
 * - 模块安装与钩子注册
 */

import OpenAIModule from '@/modules/openai';
import config from '@/config';
import * as http from 'http';
import * as loki from 'lokijs';
import * as request from 'request-promise-native';

// Mock config — 必须在最顶部，匹配 moduleNameMapper 解析后路径
jest.mock('@/config', () => ({
	__esModule: true,
	default: {
		host: 'https://misskey.test',
		i: 'test-token',
		memoryDir: '.',
		wsUrl: 'wss://misskey.test/streaming',
		apiUrl: 'https://misskey.test/api',
		keywordEnabled: false,
		reversiEnabled: false,
		notingEnabled: false,
		chartEnabled: false,
		serverMonitoring: false,
		openaiEnabled: true,
		// Deliberately fake credential used only by the mocked HTTP client below.
		openaiApiKey: 'sk-test-key',
		openaiBaseUrl: 'https://api.openai.com/v1',
		openaiModel: 'gpt-4o-mini',
		openaiMaxTokens: 1000,
		openaiTemperature: 0.5,
		openaiSystemPrompt: 'Test system prompt',
		openaiRateLimitPerMinute: 3,
		openaiMaxConcurrentRequests: 2,
		openaiDailyRequestLimit: 100,
		openaiMaxAttachmentBytes: 5 * 1024 * 1024,
	},
}));

// Mock request-promise-native
jest.mock('request-promise-native', () => ({
	post: jest.fn(),
	get: jest.fn(),
}));

type TestHarness = {
	mod: OpenAIModule;
	mockAI: any;
	db: loki;
};

const harnesses = new WeakMap<OpenAIModule, TestHarness>();

// 辅助：创建带可持久化内存集合的 mock AI 模块实例
function createModule(): OpenAIModule {
	const mod = new OpenAIModule();
	const db = new loki('openai-test.db');
	const moduleData = db.addCollection('moduleData', { indices: ['module'] });
	const mockAI: any = {
		log: jest.fn(),
		api: jest.fn().mockResolvedValue({}),
		getCollection: jest.fn((name: string, opts?: any) =>
			db.getCollection(name) || db.addCollection(name, opts)),
		moduleData,
		subscribeReply: jest.fn(),
		unsubscribeReply: jest.fn(),
		setTimeoutWithPersistence: jest.fn(),
	};
	mod.init(mockAI);
	harnesses.set(mod, { mod, mockAI, db });
	return mod;
}

function harness(mod: OpenAIModule): TestHarness {
	return harnesses.get(mod)!;
}

function createMessage(overrides: Record<string, any> = {}): any {
	return {
		id: 'user-note-1',
		userId: 'user-1',
		isDm: false,
		text: '@ai openai hello',
		extractedText: 'openai hello',
		quoteId: null,
		reply: jest.fn().mockResolvedValue({ id: 'bot-reply-1' }),
		...overrides,
	};
}

const mutableConfig = config as any;
const defaultOpenAIConfig = { ...mutableConfig };

afterEach(() => {
	Object.keys(mutableConfig).forEach(key => delete mutableConfig[key]);
	Object.assign(mutableConfig, defaultOpenAIConfig);
	jest.restoreAllMocks();
});

// ------ buildRequestBody ------

describe('buildRequestBody', () => {
	it('应使用配置中的默认值', () => {
		const mod = createModule();

		const body = mod.buildRequestBody([
			{ role: 'system', content: 'You are helpful.' },
			{ role: 'user', content: 'Hello' },
		]);

		expect(body.model).toBe('gpt-4o-mini');
		expect(body.max_tokens).toBe(1000);
		expect(body.temperature).toBe(0.5);
		expect(body.messages).toHaveLength(2);
		expect(body.messages[0].role).toBe('system');
		expect(body.messages[1].role).toBe('user');
	});

	it('应允许覆盖 model', () => {
		const mod = createModule();
		const body = mod.buildRequestBody(
			[{ role: 'user', content: 'Hi' }],
			'gpt-4-turbo',
		);
		expect(body.model).toBe('gpt-4-turbo');
	});

	it('应允许覆盖 max_tokens', () => {
		const mod = createModule();
		const body = mod.buildRequestBody(
			[{ role: 'user', content: 'Hi' }],
			undefined,
			500,
		);
		expect(body.max_tokens).toBe(500);
	});

	it('应允许覆盖 temperature', () => {
		const mod = createModule();
		const body = mod.buildRequestBody(
			[{ role: 'user', content: 'Hi' }],
			undefined,
			undefined,
			0.9,
		);
		expect(body.temperature).toBe(0.9);
	});
});

// ------ buildMessages ------

describe('buildMessages', () => {
	it('应构建包含系统提示词和用户消息的数组', () => {
		const mod = createModule();
		const messages = mod.buildMessages('You are a bot.', 'Hello!');

		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({ role: 'system', content: 'You are a bot.' });
		expect(messages[1]).toEqual({ role: 'user', content: 'Hello!' });
	});

	it('应在系统提示词和用户消息之间插入历史记录', () => {
		const mod = createModule();
		const history = [
			{ role: 'user' as const, content: 'Previous question' },
			{ role: 'assistant' as const, content: 'Previous answer' },
		];

		const messages = mod.buildMessages('System', 'New question', history);

		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({ role: 'system', content: 'System' });
		expect(messages[1]).toEqual(history[0]);
		expect(messages[2]).toEqual(history[1]);
		expect(messages[3]).toEqual({ role: 'user', content: 'New question' });
	});

	it('应支持 vision 格式的 content 数组', () => {
		const mod = createModule();
		const visionContent = [
			{ type: 'text', text: 'What is in this image?' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
		];

		const messages = mod.buildMessages('System', visionContent);
		expect(messages).toHaveLength(2);
		expect(messages[1].content).toEqual(visionContent);
	});

	it('空历史应等同于无历史', () => {
		const mod = createModule();
		const withEmpty = mod.buildMessages('S', 'Q', []);
		const without = mod.buildMessages('S', 'Q');
		expect(withEmpty).toHaveLength(without.length);
	});
});

// ------ callOpenAI ------

describe('callOpenAI', () => {
	let mod: OpenAIModule;
	const mockPost = request.post as jest.Mock;

	beforeEach(() => {
		mod = createModule();
		mockPost.mockReset();
	});

	it('应正确调用 OpenAI API 并返回内容', async () => {
		mockPost.mockResolvedValueOnce({
			choices: [{
				message: { role: 'assistant', content: 'Hello! How can I help?' },
			}],
		});

		const result = await mod.callOpenAI([{ role: 'user', content: 'Hi' }]);

		expect(result).toBe('Hello! How can I help?');
		expect(mockPost).toHaveBeenCalledTimes(1);
		const callArgs = mockPost.mock.calls[0][0];
		expect(callArgs.url).toBe('https://api.openai.com/v1/chat/completions');
		expect(callArgs.headers.Authorization).toBe('Bearer sk-test-key');
		expect(callArgs.json).toBe(true);
		expect(callArgs.timeout).toBe(60_000);
	});

	it('应在 API 返回空 choices 时返回 null', async () => {
		mockPost.mockResolvedValueOnce({ choices: [] });
		const result = await mod.callOpenAI([{ role: 'user', content: 'Hi' }]);
		expect(result).toBeNull();
	});

	it('应在 API 抛出异常时返回 null', async () => {
		mockPost.mockRejectedValueOnce(new Error('Network error'));
		const result = await mod.callOpenAI([{ role: 'user', content: 'Hi' }]);
		expect(result).toBeNull();
	});

	it('应处理 content 为空字符串的响应（trim后为空）', async () => {
		mockPost.mockResolvedValueOnce({
			choices: [{ message: { role: 'assistant', content: '  ' } }],
		});
		const result = await mod.callOpenAI([{ role: 'user', content: 'Hi' }]);
		expect(result).toBe('');
	});

	it('应处理 content 为 null 的响应', async () => {
		mockPost.mockResolvedValueOnce({
			choices: [{ message: { role: 'assistant', content: null } }],
		});
		const result = await mod.callOpenAI([{ role: 'user', content: 'Hi' }]);
		expect(result).toBeNull();
	});
});

// ------ fileToBase64 ------

describe('fileToBase64', () => {
	let mod: OpenAIModule;

	beforeEach(() => {
		mod = createModule();
	});

	async function withServer(
		handler: http.RequestListener,
		run: (url: string) => Promise<void>,
	): Promise<void> {
		const server = http.createServer(handler);
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address() as any;
		try {
			await run(`http://127.0.0.1:${address.port}/file`);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}

	it('应以流式方式下载受限大小内的图片', async () => {
		const body = Buffer.from('fake-image-data');
		await withServer((_req, res) => {
			res.writeHead(200, {
				'content-type': 'image/png',
				'content-length': body.length,
			});
			res.end(body);
		}, async url => {
			jest.spyOn(mod as any, 'resolveSafeFileUrl').mockResolvedValue({
				url: new URL(url),
				address: '127.0.0.1',
				family: 4,
			});
			const result = await mod.fileToBase64(url);
			expect(result).toEqual({
				mimeType: 'image/png',
				data: body.toString('base64'),
			});
		});
	});

	it('应拒绝非 HTTP(S) 协议和私网地址', async () => {
		expect(await mod.fileToBase64('file:///etc/passwd')).toBeNull();
		expect(await mod.fileToBase64('http://127.0.0.1/image.png')).toBeNull();
		expect(mod.isBlockedAddress('10.0.0.1')).toBe(true);
		expect(mod.isBlockedAddress('8.8.8.8')).toBe(false);
	});

	it('应拒绝超过大小限制的响应', async () => {
		mutableConfig.openaiMaxAttachmentBytes = 4;
		await withServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end(Buffer.alloc(16));
		}, async url => {
			jest.spyOn(mod as any, 'resolveSafeFileUrl').mockResolvedValue({
				url: new URL(url),
				address: '127.0.0.1',
				family: 4,
			});
			expect(await mod.fileToBase64(url)).toBeNull();
		});
	});

	it('应拒绝重定向，避免跳转绕过地址校验', async () => {
		await withServer((_req, res) => {
			res.writeHead(302, { location: 'http://127.0.0.1/internal' });
			res.end();
		}, async url => {
			jest.spyOn(mod as any, 'resolveSafeFileUrl').mockResolvedValue({
				url: new URL(url),
				address: '127.0.0.1',
				family: 4,
			});
			expect(await mod.fileToBase64(url)).toBeNull();
		});
	});

	it('应在 URL 解析失败时返回 null', async () => {
		const result = await mod.fileToBase64('not a url');
		expect(result).toBeNull();
	});

	it('应限制附件数量并跳过非图片类型', async () => {
		mutableConfig.openaiMaxAttachments = 1;
		const state = harness(mod);
		state.mockAI.api.mockResolvedValueOnce({
			files: [
				{ url: 'https://example.com/file.txt', type: 'text/plain' },
				{ url: 'https://example.com/one.png', type: 'image/png' },
				{ url: 'https://example.com/two.png', type: 'image/png' },
			],
		});
		const download = jest.spyOn(mod, 'fileToBase64').mockResolvedValue({
			mimeType: 'image/png',
			data: 'aW1hZ2U=',
		});

		const parts = await mod.extractFiles('note-1');
		expect(parts).toHaveLength(1);
		expect(download).toHaveBeenCalledTimes(1);
		expect(download).toHaveBeenCalledWith('https://example.com/one.png');
		expect(state.mockAI.log).toHaveBeenCalledWith(
			expect.stringContaining('unsupported declared attachment MIME type: text/plain'),
		);
	});
});

describe('命令路由与开关', () => {
	const mockPost = request.post as jest.Mock;

	beforeEach(() => mockPost.mockReset());

	it('只匹配独立命令，不会被 Bot 用户名或普通单词中的 ai 抢占', async () => {
		const mod = createModule();
		const hooks = mod.install();

		expect(mod.extractPrompt('openai 你好')).toBe('你好');
		expect(mod.extractPrompt('ai: hello')).toBe('hello');
		expect(mod.extractPrompt('chatting')).toBeNull();
		expect(mod.extractPrompt('chair')).toBeNull();
		expect(await hooks.mentionHook!(createMessage({
			text: '@ai fortune',
			extractedText: 'fortune',
		}))).toBe(false);
		expect(mockPost).not.toHaveBeenCalled();
	});

	it('调用模型时会移除命令词，只传递实际提示词', async () => {
		mockPost.mockResolvedValueOnce({
			choices: [{ message: { content: 'answer' } }],
		});
		const mod = createModule();
		const hooks = mod.install();
		const msg = createMessage();

		await hooks.mentionHook!(msg);

		const body = mockPost.mock.calls[0][0].body;
		expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
		expect(msg.reply).toHaveBeenCalledWith('answer');
	});

	it('空命令返回中文用法说明', async () => {
		const mod = createModule();
		const hooks = mod.install();
		const msg = createMessage({
			text: '@ai openai',
			extractedText: 'openai',
		});

		await hooks.mentionHook!(msg);
		expect(msg.reply).toHaveBeenCalledWith(
			'用法：请使用 `openai 问题内容` 的格式与我对话。',
			{ immediate: true },
		);
		expect(mockPost).not.toHaveBeenCalled();
	});

	it('未配置自定义提示词时使用中文默认系统提示词', async () => {
		delete mutableConfig.openaiSystemPrompt;
		mockPost.mockResolvedValueOnce({ choices: [{ message: { content: '回答' } }] });
		const mod = createModule();
		const hooks = mod.install();

		await hooks.mentionHook!(createMessage());
		const systemPrompt = mockPost.mock.calls[0][0].body.messages[0].content;
		expect(systemPrompt).toContain('名为「蓝」的 Misskey 看板娘 AI 女孩');
		expect(systemPrompt).toContain('亲切、自然且礼貌的中文');
	});

	it('过长输入返回中文提示且不调用模型', async () => {
		mutableConfig.openaiMaxInputChars = 3;
		const mod = createModule();
		const hooks = mod.install();
		const msg = createMessage();

		await hooks.mentionHook!(msg);
		expect(msg.reply).toHaveBeenCalledWith(
			'对话内容过长，请缩短内容后开启新的对话。',
			{ immediate: true },
		);
		expect(mockPost).not.toHaveBeenCalled();
	});

	it('模型响应失败时返回中文错误提示', async () => {
		mockPost.mockResolvedValueOnce({ choices: [] });
		const mod = createModule();
		const hooks = mod.install();
		const msg = createMessage();

		await hooks.mentionHook!(msg);
		expect(msg.reply).toHaveBeenCalledWith('抱歉，无法获取 AI 回复…');
	});

	it('openaiEnabled=false 时不注册任何处理钩子', () => {
		mutableConfig.openaiEnabled = false;
		const mod = createModule();
		expect(mod.install()).toEqual({});
		expect(harness(mod).mockAI.getCollection).not.toHaveBeenCalled();
	});
});

describe('多轮 Context 状态机', () => {
	const mockPost = request.post as jest.Mock;

	beforeEach(() => mockPost.mockReset());

	it('使用 Context key 关联公开帖的下一轮，并延续历史', async () => {
		mockPost
			.mockResolvedValueOnce({ choices: [{ message: { content: 'first answer' } }] })
			.mockResolvedValueOnce({ choices: [{ message: { content: 'second answer' } }] });
		const mod = createModule();
		const state = harness(mod);
		const hooks = mod.install();

		await hooks.mentionHook!(createMessage());
		const firstSubscription = state.mockAI.subscribeReply.mock.calls[0];
		const contextKey = firstSubscription[1];
		expect(firstSubscription.slice(2, 5)).toEqual([false, 'bot-reply-1', {}]);

		const followUp = createMessage({
			id: 'user-note-2',
			text: 'follow up',
			extractedText: 'follow up',
			reply: jest.fn().mockResolvedValue({ id: 'bot-reply-2' }),
		});
		await hooks.contextHook!(contextKey, followUp, {});

		expect(state.mockAI.unsubscribeReply).toHaveBeenCalledWith(mod, contextKey);
		const secondBody = mockPost.mock.calls[1][0].body;
		expect(secondBody.messages.map((item: any) => item.content)).toEqual([
			'Test system prompt',
			'hello',
			'first answer',
			'follow up',
		]);
		const secondContextKey = state.mockAI.subscribeReply.mock.calls[1][1];
		expect(secondContextKey).not.toBe(contextKey);
		expect(state.mockAI.subscribeReply.mock.calls[1].slice(2, 5)).toEqual([
			false,
			'bot-reply-2',
			{},
		]);
	});

	it('DM 每一轮使用独立 key，但订阅目标始终是用户 ID', async () => {
		mockPost
			.mockResolvedValueOnce({ choices: [{ message: { content: 'dm first' } }] })
			.mockResolvedValueOnce({ choices: [{ message: { content: 'dm second' } }] });
		const mod = createModule();
		const state = harness(mod);
		const hooks = mod.install();

		await hooks.mentionHook!(createMessage({
			isDm: true,
			reply: jest.fn().mockResolvedValue({ id: 'dm-reply-1' }),
		}));
		const firstKey = state.mockAI.subscribeReply.mock.calls[0][1];
		expect(state.mockAI.subscribeReply.mock.calls[0].slice(2, 5)).toEqual([
			true,
			'user-1',
			{},
		]);

		await hooks.contextHook!(firstKey, createMessage({
			id: 'dm-message-2',
			isDm: true,
			text: 'next',
			extractedText: 'next',
			reply: jest.fn().mockResolvedValue({ id: 'dm-reply-2' }),
		}), {});
		const secondSubscription = state.mockAI.subscribeReply.mock.calls[1];
		expect(secondSubscription[1]).not.toBe(firstKey);
		expect(secondSubscription.slice(2, 5)).toEqual([true, 'user-1', {}]);
	});

	it('超时同时清理 Session 和持久化 Context', async () => {
		mockPost.mockResolvedValueOnce({ choices: [{ message: { content: 'answer' } }] });
		const mod = createModule();
		const state = harness(mod);
		const hooks = mod.install();
		await hooks.mentionHook!(createMessage());

		const timerData = state.mockAI.setTimeoutWithPersistence.mock.calls[0][2];
		const contextKey = timerData.contextKey;
		expect(state.db.getCollection('openaiSessions').findOne({ key: contextKey })).not.toBeNull();

		hooks.timeoutCallback!(timerData);
		expect(state.db.getCollection('openaiSessions').findOne({ key: contextKey })).toBeNull();
		expect(state.mockAI.unsubscribeReply).toHaveBeenCalledWith(mod, contextKey);
	});

	it('找不到 Session 时也会清除陈旧 Context', async () => {
		const mod = createModule();
		const state = harness(mod);
		const hooks = mod.install();
		expect(await hooks.contextHook!('stale-key', createMessage(), {})).toBe(false);
		expect(state.mockAI.unsubscribeReply).toHaveBeenCalledWith(mod, 'stale-key');
	});
});

describe('滥用保护', () => {
	const mockPost = request.post as jest.Mock;

	beforeEach(() => mockPost.mockReset());

	it('执行每用户每分钟限流', async () => {
		mutableConfig.openaiRateLimitPerMinute = 1;
		mockPost.mockResolvedValue({ choices: [{ message: { content: 'answer' } }] });
		const mod = createModule();
		const hooks = mod.install();
		await hooks.mentionHook!(createMessage());
		const blockedMessage = createMessage({ id: 'user-note-2' });
		await hooks.mentionHook!(blockedMessage);

		expect(mockPost).toHaveBeenCalledTimes(1);
		expect(blockedMessage.reply).toHaveBeenCalledWith(
			expect.stringContaining('1 分钟'),
			{ immediate: true },
		);
	});

	it('执行持久化的全局每日请求上限', async () => {
		mutableConfig.openaiDailyRequestLimit = 1;
		mockPost.mockResolvedValue({ choices: [{ message: { content: 'answer' } }] });
		const mod = createModule();
		const hooks = mod.install();
		await hooks.mentionHook!(createMessage());
		const blockedMessage = createMessage({ userId: 'user-2', id: 'user-note-2' });
		await hooks.mentionHook!(blockedMessage);

		expect(mockPost).toHaveBeenCalledTimes(1);
		expect(blockedMessage.reply).toHaveBeenCalledWith(
			expect.stringContaining('今日 AI 使用次数已达上限'),
			{ immediate: true },
		);
	});

	it('执行全局并发上限', async () => {
		mutableConfig.openaiMaxConcurrentRequests = 1;
		let finishFirst!: (value: any) => void;
		mockPost.mockReturnValueOnce(new Promise(resolve => {
			finishFirst = resolve;
		}));
		const mod = createModule();
		const hooks = mod.install();
		const first = hooks.mentionHook!(createMessage());
		await new Promise(resolve => setImmediate(resolve));

		const blockedMessage = createMessage({ userId: 'user-2', id: 'user-note-2' });
		await hooks.mentionHook!(blockedMessage);
		expect(blockedMessage.reply).toHaveBeenCalledWith(
			expect.stringContaining('当前繁忙'),
			{ immediate: true },
		);

		finishFirst({ choices: [{ message: { content: 'answer' } }] });
		await first;
		expect(mockPost).toHaveBeenCalledTimes(1);
	});

	it('配置白名单后拒绝未授权用户', async () => {
		mutableConfig.openaiAllowedUserIds = ['trusted-user'];
		const mod = createModule();
		const hooks = mod.install();
		const blockedMessage = createMessage({ userId: 'unknown-user' });
		await hooks.mentionHook!(blockedMessage);

		expect(mockPost).not.toHaveBeenCalled();
		expect(blockedMessage.reply).toHaveBeenCalledWith(
			expect.stringContaining('权限'),
			{ immediate: true },
		);
	});

	it('定期清理没有近期请求的用户限流记录', () => {
		const mod = createModule();
		const state = harness(mod);
		mod.install();
		let now = 1;
		jest.spyOn(Date, 'now').mockImplementation(() => now);

		expect((mod as any).acquireRequest('old-user')).toBeNull();
		(mod as any).releaseRequest();
		now = 60_002;
		expect((mod as any).acquireRequest('new-user')).toBeNull();
		(mod as any).releaseRequest();

		expect((mod as any).requestsByUser.has('old-user')).toBe(false);
		expect((mod as any).requestsByUser.has('new-user')).toBe(true);
		expect(state.mockAI.log).toHaveBeenCalledWith(
			expect.stringContaining('Cleaned 1 expired rate-limit entries'),
		);
	});

	it('并发计数器下溢时记录警告并保持为零', () => {
		const mod = createModule();
		const state = harness(mod);
		mod.install();

		(mod as any).releaseRequest();
		expect((mod as any).activeRequests).toBe(0);
		expect(state.mockAI.log).toHaveBeenCalledWith(
			expect.stringContaining('WARNING: active request counter underflow prevented'),
		);
	});
});

// ------ 模块安装 ------

describe('模块安装', () => {
	it('install 应返回三个钩子函数', () => {
		const mod = createModule();
		const result = mod.install();

		expect(result).toBeDefined();
		expect(typeof result.mentionHook).toBe('function');
		expect(typeof result.contextHook).toBe('function');
		expect(typeof result.timeoutCallback).toBe('function');
	});

	it('模块名称应为 openai', () => {
		const mod = new OpenAIModule();
		expect(mod.name).toBe('openai');
	});
});
