export default function fixedTime(timeZone: string): { hour: number; date: string } {
	const now = new Date();

	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	});

	const parts: any = {};
	for (const part of fmt.formatToParts(now)) {
		if (part.type !== 'literal') parts[part.type] = part.value;
	}

	return {
		hour: Number(parts.hour),
		date: `${parts.year}-${parts.month}-${parts.day}`,
	};
}
