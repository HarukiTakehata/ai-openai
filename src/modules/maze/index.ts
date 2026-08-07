import autobind from 'autobind-decorator';
import Module from '@/module';
import serifs from '@/serifs';
import config from '@/config';
import fixedTime from '@/utils/fixed-time';
import { genMaze } from './gen-maze';
import { renderMaze } from './render-maze';
import Message from '@/message';

export default class extends Module {
	public readonly name = 'maze';

	@autobind
	public install() {
		this.post();
		setInterval(this.post, 1000 * 60 * 3);

		return {
			mentionHook: this.mentionHook
		};
	}

	@autobind
	private async post() {
		const time = fixedTime(config.mazePostTimezone || 'Asia/Shanghai');
		if (time.hour !== (config.mazePostHour ?? 22)) return;

		const data = this.getData();
		if (data.lastPosted == time.date) return;

		data.lastPosted = time.date;
		this.setData(data);

		this.log('Time to maze');
		try {
			const file = await this.genMazeFile(time.date);

			this.log('Posting...');
			await this.ai.post({
				text: serifs.maze.post,
				fileIds: [file.id]
			});
		} catch (e) {
			this.log(`Failed to post maze: ${e}`);
		}
	}

	@autobind
	private async genMazeFile(seed, size?): Promise<any> {
		this.log('Maze generating...');
		const maze = genMaze(seed, size);

		this.log('Maze rendering...');
		const data = renderMaze(seed, maze);

		this.log('Image uploading...');
		const file = await this.ai.upload(data, {
			filename: 'maze.png',
			contentType: 'image/png'
		});

		return file;
	}

	@autobind
	private async mentionHook(msg: Message) {
		if (msg.includes(['迷路','迷宫'])) {
			let size: string | null = null;
			if (msg.includes(['娱乐', '照顾','幼儿园'])) size = 'veryEasy';
			if (msg.includes(['简单', '轻松', '容易'])) size = 'easy';
			if (msg.includes(['难', '艰', '复杂', '离谱'])) size = 'hard';
			if (msg.includes(['死', '鬼', '地狱', '变态'])) size = 'veryHard';
			if (msg.includes(['猫猫']) && msg.includes(['自己'])) size = 'ai';
			this.log('Maze requested');
			setTimeout(async () => {
				const file = await this.genMazeFile(Date.now(), size);
				this.log('Replying...');
				msg.reply(serifs.maze.foryou, { file });
			}, 3000);
			return {
				reaction: 'like'
			};
		} else {
			return false;
		}
	}
}
