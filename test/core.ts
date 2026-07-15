import TestModule from '#/__modules__/test';

function createModule() {
	const mod = new TestModule();
	const moduleData: any[] = [];
	const mockAI: any = {
		log: jest.fn(),
		moduleData: {
			findOne: jest.fn(() => null),
			insertOne: jest.fn((doc: any) => {
				moduleData.push(doc);
				return doc;
			}),
			update: jest.fn(),
		},
	};
	mod.init(mockAI);
	return { mod, mockAI, hooks: mod.install() };
}

describe('module mention routing', () => {
	it('handles matching messages and replies immediately', async () => {
		const { hooks } = createModule();
		const msg: any = {
			text: 'ping',
			reply: jest.fn(),
		};

		expect(await hooks.mentionHook!(msg)).toBe(true);
		expect(msg.reply).toHaveBeenCalledWith('PONG!', { immediate: true });
	});

	it('returns false for unrelated messages', async () => {
		const { hooks } = createModule();
		const msg: any = {
			text: 'fortune',
			reply: jest.fn(),
		};

		expect(await hooks.mentionHook!(msg)).toBe(false);
		expect(msg.reply).not.toHaveBeenCalled();
	});
});
