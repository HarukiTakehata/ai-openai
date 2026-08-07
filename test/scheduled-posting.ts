import MazeModule from '@/modules/maze';
import NotingModule from '@/modules/noting';
import config from '@/config';
import * as loki from 'lokijs';

// Mock config — 必须在最顶部，匹配 moduleNameMapper 解析后路径
jest.mock('@/config', () => ({
	__esModule: true,
	default: {
		host: 'https://misskey.test',
		i: 'test-token',
		wsUrl: 'wss://misskey.test/streaming',
		apiUrl: 'https://misskey.test/api',
		notingEnabled: true,
		notingPostIntervalMinutes: 15,
		notingPostProbability: 0.02,
		mazePostHour: 22,
		mazePostTimezone: 'Asia/Shanghai',
	},
}));

// Mock 时区工具，避免测试依赖真实时钟
jest.mock('@/utils/fixed-time', () => ({
	__esModule: true,
	default: jest.fn(() => ({ hour: 22, date: '2026-08-07' })),
}));

// Mock 迷宫生成/渲染，避免加载 node-canvas
jest.mock('@/modules/maze/gen-maze', () => ({
	__esModule: true,
	genMaze: jest.fn(() => []),
}));

jest.mock('@/modules/maze/render-maze', () => ({
	__esModule: true,
	renderMaze: jest.fn(() => Buffer.from('fake-png')),
}));

import fixedTime from '@/utils/fixed-time';

const mockFixedTime = fixedTime as jest.Mock;
const mutableConfig = config as any;
const defaultConfig = { ...mutableConfig };

function createMazeModule() {
	const mod = new MazeModule();
	const db = new loki('maze-test.db');
	const moduleData = db.addCollection('moduleData', { indices: ['module'] });
	const mockAI: any = {
		log: jest.fn(),
		moduleData,
		upload: jest.fn().mockResolvedValue({ id: 'file-1' }),
		post: jest.fn().mockResolvedValue({ id: 'note-1' }),
	};
	mod.init(mockAI);
	return { mod, mockAI };
}

function createNotingModule() {
	const mod = new NotingModule();
	const db = new loki('noting-test.db');
	const moduleData = db.addCollection('moduleData', { indices: ['module'] });
	const mockAI: any = {
		log: jest.fn(),
		moduleData,
		post: jest.fn().mockResolvedValue({}),
	};
	mod.init(mockAI);
	return { mod, mockAI };
}

afterEach(() => {
	Object.keys(mutableConfig).forEach(key => delete mutableConfig[key]);
	Object.assign(mutableConfig, defaultConfig);
	mockFixedTime.mockReset();
	mockFixedTime.mockReturnValue({ hour: 22, date: '2026-08-07' });
	jest.clearAllTimers();
	jest.useRealTimers();
	jest.restoreAllMocks();
});

describe('maze 自动发送', () => {
	it('系统故障错过发送窗口后不补发（非目标小时不发送）', async () => {
		mockFixedTime.mockReturnValue({ hour: 21, date: '2026-08-07' });
		const { mod, mockAI } = createMazeModule();

		await (mod as any).post();

		expect(mockAI.upload).not.toHaveBeenCalled();
		expect(mockAI.post).not.toHaveBeenCalled();
	});

	it('到点发送并写入 lastPosted', async () => {
		const { mod, mockAI } = createMazeModule();

		await (mod as any).post();

		expect(mockAI.upload).toHaveBeenCalledTimes(1);
		expect(mockAI.post).toHaveBeenCalledWith({
			text: '这是今日份的迷宫！ #AiMaze',
			fileIds: ['file-1'],
		});
		const doc = mockAI.moduleData.findOne({ module: 'maze' });
		expect(doc.data.lastPosted).toBe('2026-08-07');
	});

	it('同一日期只发送一次（去重）', async () => {
		const { mod, mockAI } = createMazeModule();
		mockAI.moduleData.findOne({ module: 'maze' }).data.lastPosted = '2026-08-07';

		await (mod as any).post();

		expect(mockAI.upload).not.toHaveBeenCalled();
		expect(mockAI.post).not.toHaveBeenCalled();
	});

	it('发送失败时仍标记 lastPosted，不补发且不抛出', async () => {
		const { mod, mockAI } = createMazeModule();
		mockAI.post.mockRejectedValueOnce(new Error('network'));

		await expect((mod as any).post()).resolves.toBeUndefined();

		const doc = mockAI.moduleData.findOne({ module: 'maze' });
		expect(doc.data.lastPosted).toBe('2026-08-07');
		expect(mockAI.log).toHaveBeenCalledWith(
			expect.stringContaining('Failed to post maze'),
		);
	});

	it('使用配置的 mazePostHour 判断发送时刻', async () => {
		mutableConfig.mazePostHour = 23;
		mockFixedTime.mockReturnValue({ hour: 23, date: '2026-08-07' });
		const { mod, mockAI } = createMazeModule();

		await (mod as any).post();

		expect(mockAI.post).toHaveBeenCalledTimes(1);
	});
});

describe('noting 自动发送', () => {
	it('按配置的间隔与概率触发发帖', () => {
		jest.useFakeTimers();
		const random = jest.spyOn(Math, 'random').mockReturnValue(0.01);
		const { mod, mockAI } = createNotingModule();

		mod.install();
		jest.advanceTimersByTime(1000 * 60 * 15);

		expect(mockAI.post).toHaveBeenCalledTimes(1);
		random.mockRestore();
	});

	it('概率未命中时不发帖', () => {
		jest.useFakeTimers();
		const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
		const { mod, mockAI } = createNotingModule();

		mod.install();
		jest.advanceTimersByTime(1000 * 60 * 30);

		expect(mockAI.post).not.toHaveBeenCalled();
		random.mockRestore();
	});

	it('未配置时使用默认间隔 10 分钟与概率 0.04', () => {
		delete mutableConfig.notingPostIntervalMinutes;
		delete mutableConfig.notingPostProbability;
		jest.useFakeTimers();
		const random = jest.spyOn(Math, 'random').mockReturnValue(0.03);
		const { mod, mockAI } = createNotingModule();

		mod.install();
		jest.advanceTimersByTime(1000 * 60 * 10);

		expect(mockAI.post).toHaveBeenCalledTimes(1);
		random.mockRestore();
	});

	it('notingEnabled=false 时不注册定时器', () => {
		mutableConfig.notingEnabled = false;
		jest.useFakeTimers();
		const { mod, mockAI } = createNotingModule();

		expect(mod.install()).toEqual({});
		jest.advanceTimersByTime(1000 * 60 * 30);

		expect(mockAI.post).not.toHaveBeenCalled();
	});

	it('发帖失败记录日志而不抛出', async () => {
		const { mod, mockAI } = createNotingModule();
		mockAI.post.mockRejectedValueOnce(new Error('boom'));

		await expect((mod as any).post()).resolves.toBeUndefined();

		expect(mockAI.log).toHaveBeenCalledWith(
			expect.stringContaining('Failed to post noting note'),
		);
	});
});
