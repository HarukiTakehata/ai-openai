import autobind from 'autobind-decorator';
import Module from '@/module';
import serifs from '@/serifs';
import { genItem } from '@/vocabulary';
import config from '@/config';

export default class extends Module {
	public readonly name = 'noting';

	@autobind
	public install() {
		if (!config.notingEnabled) return {};

		const interval = (config.notingPostIntervalMinutes ?? 10) * 1000 * 60;
		const probability = config.notingPostProbability ?? 0.04;

		setInterval(() => {
			if (Math.random() < probability) {
				this.post();
			}
		}, interval);

		return {};
	}

	@autobind
	private async post() {
		const notes = [
			...serifs.noting.notes,
			() => {
				const item = genItem();
				return serifs.noting.want(item);
			},
			() => {
				const item = genItem();
				return serifs.noting.see(item);
			},
			() => {
				const item = genItem();
				return serifs.noting.expire(item);
			},
		];

		const note = notes[Math.floor(Math.random() * notes.length)];

		// TODO: 季節に応じたセリフ

		try {
			await this.ai.post({
				text: typeof note === 'function' ? note() : note
			});
		} catch (e) {
			this.log(`Failed to post noting note: ${e}`);
		}
	}
}
