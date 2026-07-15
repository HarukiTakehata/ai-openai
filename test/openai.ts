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
		openaiApiKey: 'sk-test-key',
		openaiBaseUrl: 'https://api.openai.com/v1',
		openaiModel: 'gpt-4o-mini',
		openaiMaxTokens: 1000,
		openaiTemperature: 0.5,
		openaiSystemPrompt: 'Test system prompt',
	},
}));

// Mock request-promise-native
jest.mock('request-promise-native', () => ({
	post: jest.fn(),
	get: jest.fn(),
}));

// 辅助：创建带 mock AI 的模块实例
function createModule(): OpenAIModule {
	const mod = new OpenAIModule();
	const mockAI: any = {
		log: () => {},
		api: jest.fn().mockResolvedValue({}),
		getCollection: jest.fn().mockReturnValue({
			findOne: () => null,
			find: () => [],
			insertOne: (doc: any) => doc,
			update: () => {},
			findAndRemove: () => {},
			remove: () => {},
		}),
		moduleData: {
			findOne: () => null,
			insertOne: (doc: any) => doc,
			update: () => {},
		},
		subscribeReply: jest.fn(),
		unsubscribeReply: jest.fn(),
		setTimeoutWithPersistence: jest.fn(),
	};
	mod.init(mockAI);
	return mod;
}

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
	const mockGet = request.get as jest.Mock;

	beforeEach(() => {
		mod = createModule();
		mockGet.mockReset();
	});

	it('应下载文件并转换为 base64 data URL 格式', async () => {
		const buf = Buffer.from('fake-image-data');
		mockGet.mockResolvedValueOnce({
			body: buf,
			headers: { 'content-type': 'image/png' },
		});

		const result = await mod.fileToBase64('https://example.com/image.png');

		expect(result).not.toBeNull();
		expect(result!.mimeType).toBe('image/png');
		expect(result!.data).toBe(buf.toString('base64'));
		expect(mockGet).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://example.com/image.png',
				encoding: null,
			}),
		);
	});

	it('应在下载失败时返回 null', async () => {
		mockGet.mockRejectedValueOnce(new Error('Download failed'));
		const result = await mod.fileToBase64('https://invalid.url/');
		expect(result).toBeNull();
	});

	it('应处理无 content-type header 的情况', async () => {
		const buf = Buffer.from('data');
		mockGet.mockResolvedValueOnce({ body: buf, headers: {} });
		const result = await mod.fileToBase64('https://example.com/file');
		expect(result!.mimeType).toBe('application/octet-stream');
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
