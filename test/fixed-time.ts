import fixedTime from '@/utils/fixed-time';

describe('fixedTime', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('按 Asia/Shanghai 返回正确小时与日期键（月份不偏移）', () => {
		jest.useFakeTimers({ now: new Date('2026-08-07T14:00:00Z') });
		expect(fixedTime('Asia/Shanghai')).toEqual({ hour: 22, date: '2026-08-07' });
	});

	it('跨 UTC 日期边界时使用目标时区的日期', () => {
		// 16:30 UTC = 次日 00:30 (Asia/Shanghai)
		jest.useFakeTimers({ now: new Date('2026-01-02T16:30:00Z') });
		expect(fixedTime('Asia/Shanghai')).toEqual({ hour: 0, date: '2026-01-03' });
	});

	it('UTC 时区下与原日期一致', () => {
		jest.useFakeTimers({ now: new Date('2026-08-07T22:00:00Z') });
		expect(fixedTime('UTC')).toEqual({ hour: 22, date: '2026-08-07' });
	});

	it('目标时区跨天时日期比 UTC 早一天', () => {
		// 08-07 22:00 UTC = 08-08 06:00 (Asia/Shanghai)
		jest.useFakeTimers({ now: new Date('2026-08-07T22:00:00Z') });
		expect(fixedTime('Asia/Shanghai')).toEqual({ hour: 6, date: '2026-08-08' });
	});
});
