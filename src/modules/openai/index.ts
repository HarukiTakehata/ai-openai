import autobind from 'autobind-decorator';
import * as request from 'request-promise-native';
import * as loki from 'lokijs';

import Module from '@/module';
import Message from '@/message';
import config from '@/config';

/**
 * OpenAI 兼容 API 的对话历史条目
 */
interface ChatHistory {
	role: 'system' | 'user' | 'assistant';
	content: string | any[];
}

/**
 * 持久化的会话记录
 */
interface ChatSession {
	postId: string;
	createdAt: number;
	fromMention: boolean;
	history?: ChatHistory[];
}

// ------ 常量 ------
const MODULE_TRIGGER = 'openai';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 2800;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_SYSTEM_PROMPT =
	'あなたはMisskey看板娘の女の子AI、藍として振る舞ってください。' +
	'丁寧で親しみやすい口調で、ユーザーを「ご主人様」と呼びます。' +
	'Markdownを使って2800文字以内で回答してください。';

// 对话超时时间（30分钟）
const TIMEOUT_TIME = 1000 * 60 * 30;
// 默认随机聊天概率
const DEFAULT_RANDOM_TALK_PROBABILITY = 0.02;
// 默认随机聊天间隔（12小时）
const DEFAULT_RANDOM_TALK_INTERVAL = 1000 * 60 * 60 * 12;

export default class extends Module {
	public readonly name = 'openai';

	private sessions!: loki.Collection<ChatSession>;
	private randomTalkProbability: number = DEFAULT_RANDOM_TALK_PROBABILITY;
	private randomTalkIntervalMs: number = DEFAULT_RANDOM_TALK_INTERVAL;

	@autobind
	public install() {
		// 初始化持久化集合
		this.sessions = this.ai.getCollection('openaiSessions', {
			indices: ['postId'],
		});

		// 读取配置
		if (config.openaiRandomTalkProbability != null) {
			this.randomTalkProbability = config.openaiRandomTalkProbability;
		}
		if (config.openaiRandomTalkIntervalMinutes != null) {
			this.randomTalkIntervalMs =
				1000 * 60 * config.openaiRandomTalkIntervalMinutes;
		}

		this.log('openaiEnabled: ' + config.openaiEnabled);
		this.log('openaiModel: ' + (config.openaiModel || DEFAULT_MODEL));
		this.log('openaiBaseUrl: ' + (config.openaiBaseUrl || DEFAULT_BASE_URL));
		this.log('randomTalkProbability: ' + this.randomTalkProbability);
		this.log('randomTalkIntervalMinutes: ' + (this.randomTalkIntervalMs / 60000));

		// 随机聊天定时器
		if (config.openaiRandomTalkEnabled) {
			setInterval(this.randomTalk, this.randomTalkIntervalMs);
		}

		return {
			mentionHook: this.mentionHook,
			contextHook: this.contextHook,
			timeoutCallback: this.timeoutCallback,
		};
	}

	// ------ 公开方法（供测试使用） ------

	/**
	 * 构建 OpenAI API 请求体
	 */
	@autobind
	public buildRequestBody(
		messages: ChatHistory[],
		model?: string,
		maxTokens?: number,
		temperature?: number,
	): any {
		return {
			model: model || config.openaiModel || DEFAULT_MODEL,
			messages: messages,
			max_tokens: maxTokens || config.openaiMaxTokens || DEFAULT_MAX_TOKENS,
			temperature:
				temperature != null
					? temperature
					: config.openaiTemperature != null
						? config.openaiTemperature
						: DEFAULT_TEMPERATURE,
		};
	}

	/**
	 * 构建对话消息列表
	 */
	@autobind
	public buildMessages(
		systemPrompt: string,
		userContent: string | any[],
		history?: ChatHistory[],
	): ChatHistory[] {
		const messages: ChatHistory[] = [];

		// 系统提示词
		messages.push({ role: 'system', content: systemPrompt });

		// 历史对话
		if (history && history.length > 0) {
			messages.push(...history);
		}

		// 当前用户消息
		messages.push({ role: 'user', content: userContent });

		return messages;
	}

	/**
	 * 调用 OpenAI 兼容 API
	 */
	@autobind
	public async callOpenAI(messages: ChatHistory[]): Promise<string | null> {
		const baseUrl = config.openaiBaseUrl || DEFAULT_BASE_URL;
		const apiKey = config.openaiApiKey;
		const model = config.openaiModel || DEFAULT_MODEL;

		if (!apiKey) {
			this.log('ERROR: openaiApiKey not configured');
			return null;
		}

		const body = this.buildRequestBody(messages);

		const url = `${baseUrl}/chat/completions`;
		this.log(`Calling OpenAI API: ${url} model=${model}`);

		try {
			const res = await request.post({
				url: url,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: body,
				json: true,
			});

			this.log('OpenAI API response received');

			if (res && res.choices && res.choices.length > 0) {
				const content = res.choices[0].message?.content;
				if (content) {
					return content.trim();
				}
			}

			this.log('WARNING: No content in response');
			return null;
		} catch (err: any) {
			this.log('ERROR calling OpenAI API: ' + (err.message || err));
			if (err.error) {
				this.log('API error detail: ' + JSON.stringify(err.error));
			}
			return null;
		}
	}

	// ------ 文件处理 ------

	/**
	 * 将远程文件下载并转为 base64
	 */
	@autobind
	public async fileToBase64(fileUrl: string): Promise<{ mimeType: string; data: string } | null> {
		try {
			const res = await request.get({
				url: fileUrl,
				encoding: null, // 获取 Buffer
				resolveWithFullResponse: true,
			});

			const buffer = res.body as Buffer;
			const mimeType = res.headers['content-type'] || 'application/octet-stream';
			const data = buffer.toString('base64');

			return { mimeType, data };
		} catch (err: any) {
			this.log('ERROR downloading file: ' + (err.message || err));
			return null;
		}
	}

	/**
	 * 从 Misskey Note 中提取文件并转为 OpenAI vision 格式
	 */
	@autobind
	public async extractFiles(noteId: string): Promise<any[]> {
		const parts: any[] = [];

		try {
			const noteData = await this.ai.api('notes/show', { noteId });
			if (!noteData || !noteData.files) return parts;

			for (const file of noteData.files) {
				const fileUrl = file.url || file.thumbnailUrl;
				if (!fileUrl) continue;

				const mimeType = file.type || 'image/png';

				// 只处理图片类型（OpenAI vision 支持的类型）
				if (
					mimeType.startsWith('image/') ||
					mimeType === 'application/octet-stream'
				) {
					const result = await this.fileToBase64(fileUrl);
					if (result) {
						parts.push({
							type: 'image_url',
							image_url: {
								url: `data:${result.mimeType};base64,${result.data}`,
								detail: 'auto',
							},
						});
					}
				}
			}
		} catch (err: any) {
			this.log('ERROR extracting files: ' + (err.message || err));
		}

		return parts;
	}

	// ------ 模块钩子 ------

	/**
	 * mentionHook：处理 @ai openai 触发的对话
	 */
	@autobind
	private async mentionHook(msg: Message): Promise<boolean | { reaction: string | null; immediate?: boolean }> {
		if (!msg.includes([MODULE_TRIGGER, 'ai', 'chat'])) {
			return false;
		}

		// 检查是否已在活跃会话中
		const noteId = msg.id;
		if (noteId) {
			const exist = this.sessions.findOne({ postId: noteId });
			if (exist) return false; // 已在会话中
		}

		this.log('OpenAI chat requested');

		const session: ChatSession = {
			postId: msg.id,
			createdAt: Date.now(),
			fromMention: true,
		};

		// 检查是否有引用 Renote
		if (msg.quoteId) {
			try {
				const quotedNote = await this.ai.api('notes/show', {
					noteId: msg.quoteId,
				});
				if (quotedNote && quotedNote.text) {
					session.history = [
						{
							role: 'user',
							content: `ユーザーが与えた引用文章: ${quotedNote.text}`,
						},
					];
				}
			} catch (err: any) {
				this.log('Failed to fetch quoted note: ' + (err.message || err));
			}
		}

		const result = await this.handleChat(session, msg);

		if (result) {
			return { reaction: 'like' };
		}
		return false;
	}

	/**
	 * contextHook：处理多轮对话的后续回复
	 */
	@autobind
	private async contextHook(
		key: any,
		msg: Message,
		data?: any,
	): Promise<boolean | { reaction: string | null; immediate?: boolean }> {
		this.log('contextHook triggered');

		if (!msg.text) return false;

		// 查找会话
		const noteId = msg.id;
		const exist = this.sessions.findOne({ postId: noteId });
		if (!exist) {
			this.log('No session found for this message');
			return false;
		}

		// 取消订阅并移除会话记录
		this.unsubscribeReply(key);
		this.sessions.remove(exist);

		const result = await this.handleChat(exist, msg);

		if (result) {
			return { reaction: 'like' };
		}
		return false;
	}

	// ------ 核心对话处理 ------

	/**
	 * 核心对话处理逻辑
	 */
	@autobind
	private async handleChat(
		session: ChatSession,
		msg: Message,
	): Promise<boolean> {
		const extractedText = msg.extractedText || msg.text || '';

		// 构建用户消息内容
		let userContent: string | any[] = extractedText;

		// 处理附件（图片等）
		const fileParts = await this.extractFiles(msg.id);
		if (fileParts.length > 0) {
			userContent = [
				{ type: 'text', text: extractedText },
				...fileParts,
			];
		}

		// 构建消息
		const systemPrompt =
			config.openaiSystemPrompt || DEFAULT_SYSTEM_PROMPT;
		const messages = this.buildMessages(
			systemPrompt,
			userContent,
			session.history,
		);

		// 调用 API
		const responseText = await this.callOpenAI(messages);

		if (!responseText) {
			msg.reply('ごめんなさい、AIの応答を取得できませんでした…');
			return false;
		}

		// 发送回复并建立新的订阅
		const reply = await msg.reply(responseText);
		if (reply) {
			// 更新历史用于下一轮
			const newHistory = [...(session.history || [])];
			newHistory.push({ role: 'user', content: extractedText });
			newHistory.push({ role: 'assistant', content: responseText });

			// 限制历史长度（最多保留10轮）
			if (newHistory.length > 20) {
				// 保留 system prompt 位置 + 最近的历史
				newHistory.splice(0, newHistory.length - 20);
			}

			const newPostId = msg.isDm ? msg.userId : reply.id;

			// 儲存新的会话记录
			this.sessions.insertOne({
				postId: newPostId,
				createdAt: Date.now(),
				fromMention: session.fromMention,
				history: newHistory,
			} as ChatSession);

			// 订阅后续回复
			this.subscribeReply(msg.userId, msg.isDm, newPostId, {});

			// 设置超时
			this.setTimeoutWithPersistence(TIMEOUT_TIME, {
				noteId: newPostId,
			});
		}

		return true;
	}

	// ------ 超时回调 ------

	@autobind
	private timeoutCallback(data: any) {
		if (data && data.noteId) {
			this.sessions.findAndRemove({ postId: data.noteId });
			this.log(`Session expired: ${data.noteId}`);
		}
	}

	// ------ 随机聊天 ------

	@autobind
	private async randomTalk() {
		this.log('randomTalk triggered');
		// TODO: 实现从时间线随机选取用户发起对话
		// 需要获取时间线数据 → 筛选非Bot用户 → 随机选取 → 发送消息
	}
}
