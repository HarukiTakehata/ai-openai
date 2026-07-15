import autobind from 'autobind-decorator';
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as request from 'request-promise-native';
import * as loki from 'lokijs';
import { v4 as uuid } from 'uuid';

import Module from '@/module';
import Message from '@/message';
import config from '@/config';

interface ChatHistory {
	role: 'system' | 'user' | 'assistant';
	content: string | any[];
}

interface ChatSession {
	key: string;
	createdAt: number;
	fromMention: boolean;
	history?: ChatHistory[];
}

interface DailyUsage {
	day: string;
	requests: number;
}

interface ResolvedFileUrl {
	url: URL;
	address: string;
	family: number;
}

type UsageBlockReason = 'not-allowed' | 'rate-limit' | 'concurrency' | 'daily-limit';

const MODULE_TRIGGER = /^(?:openai|ai|chat)(?=$|\s|[：:])/i;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 2800;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 2;
const DEFAULT_MAX_INPUT_CHARS = 12_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 3;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const DEFAULT_DAILY_REQUEST_LIMIT = 100;
const TIMEOUT_TIME = 1000 * 60 * 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
const SUPPORTED_IMAGE_TYPES = new Set([
	'image/gif',
	'image/jpeg',
	'image/png',
	'image/webp',
]);
const DEFAULT_SYSTEM_PROMPT =
	'你是一个名为「蓝」的 Misskey 看板娘 AI 女孩。' +
	'请使用亲切、自然且礼貌的中文，将用户称为「主人」。' +
	'请使用 Markdown 格式，并在 2800 字以内回答。';

// Reject addresses that could reach the host, local network, or non-routable ranges.
// DNS results are checked before the selected public address is pinned to the request.
const blockedNetworks = new net.BlockList();
[
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
].forEach(([address, prefix]) => blockedNetworks.addSubnet(address as string, prefix as number, 'ipv4'));
[
	['::', 128],
	['::1', 128],
	['64:ff9b::', 96],
	['100::', 64],
	['2001:db8::', 32],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
].forEach(([address, prefix]) => blockedNetworks.addSubnet(address as string, prefix as number, 'ipv6'));

export default class extends Module {
	public readonly name = 'openai';

	private sessions!: loki.Collection<ChatSession>;
	private usage!: loki.Collection<DailyUsage>;
	// Per-minute timestamps stay in memory; the UTC daily counter is persisted in Loki.
	private requestsByUser = new Map<string, number[]>();
	private activeRequests = 0;
	private lastRateLimitCleanupAt = 0;

	@autobind
	public install() {
		this.log('openaiEnabled: ' + config.openaiEnabled);
		if (config.openaiEnabled !== true) {
			this.log('OpenAI module disabled; no hooks registered');
			return {};
		}

		this.sessions = this.ai.getCollection('openaiSessions', {
			indices: ['key'],
		});
		this.sessions.ensureIndex('key');
		this.usage = this.ai.getCollection('openaiUsage', {
			indices: ['day'],
		});
		this.usage.ensureIndex('day');

		this.log('openaiModel: ' + (config.openaiModel || DEFAULT_MODEL));
		this.log('openaiBaseUrl: ' + (config.openaiBaseUrl || DEFAULT_BASE_URL));
		this.log('rateLimitPerMinute: ' + this.rateLimitPerMinute);
		this.log('maxConcurrentRequests: ' + this.maxConcurrentRequests);
		this.log('dailyRequestLimit: ' + this.dailyRequestLimit);

		return {
			mentionHook: this.mentionHook,
			contextHook: this.contextHook,
			timeoutCallback: this.timeoutCallback,
		};
	}

	private get requestTimeoutMs(): number {
		return this.positiveInteger(config.openaiRequestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
	}

	private get fileDownloadTimeoutMs(): number {
		return this.positiveInteger(
			config.openaiFileDownloadTimeoutMs,
			DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS,
		);
	}

	private get maxAttachmentBytes(): number {
		return this.positiveInteger(config.openaiMaxAttachmentBytes, DEFAULT_MAX_ATTACHMENT_BYTES);
	}

	private get maxAttachments(): number {
		return this.positiveInteger(config.openaiMaxAttachments, DEFAULT_MAX_ATTACHMENTS);
	}

	private get maxInputChars(): number {
		return this.positiveInteger(config.openaiMaxInputChars, DEFAULT_MAX_INPUT_CHARS);
	}

	private get rateLimitPerMinute(): number {
		return this.positiveInteger(
			config.openaiRateLimitPerMinute,
			DEFAULT_RATE_LIMIT_PER_MINUTE,
		);
	}

	private get maxConcurrentRequests(): number {
		return this.positiveInteger(
			config.openaiMaxConcurrentRequests,
			DEFAULT_MAX_CONCURRENT_REQUESTS,
		);
	}

	private get dailyRequestLimit(): number {
		return this.positiveInteger(config.openaiDailyRequestLimit, DEFAULT_DAILY_REQUEST_LIMIT);
	}

	private positiveInteger(value: number | undefined, fallback: number): number {
		return value != null && Number.isFinite(value) && value > 0
			? Math.floor(value)
			: fallback;
	}

	/** 解析严格边界的聊天命令，并移除命令前缀。 */
	@autobind
	public extractPrompt(text: string): string | null {
		if (!text) return null;
		const match = text.trim().match(MODULE_TRIGGER);
		if (!match) return null;
		return text.trim().slice(match[0].length).replace(/^[\s：:]+/, '').trim();
	}

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

	@autobind
	public buildMessages(
		systemPrompt: string,
		userContent: string | any[],
		history?: ChatHistory[],
	): ChatHistory[] {
		const messages: ChatHistory[] = [{ role: 'system', content: systemPrompt }];
		if (history && history.length > 0) messages.push(...history);
		messages.push({ role: 'user', content: userContent });
		return messages;
	}

	@autobind
	public async callOpenAI(messages: ChatHistory[]): Promise<string | null> {
		const baseUrl = (config.openaiBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
		const apiKey = config.openaiApiKey;
		const model = config.openaiModel || DEFAULT_MODEL;

		if (!apiKey) {
			this.log('ERROR: openaiApiKey not configured');
			return null;
		}

		const url = `${baseUrl}/chat/completions`;
		this.log(`Calling OpenAI API: ${url} model=${model}`);

		try {
			const res = await request.post({
				url,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: this.buildRequestBody(messages),
				json: true,
				timeout: this.requestTimeoutMs,
			});
			this.log('OpenAI API response received');

			const content = res?.choices?.[0]?.message?.content;
			if (typeof content === 'string') return content.trim();

			this.log('WARNING: No content in response');
			return null;
		} catch (err: any) {
			this.log('ERROR calling OpenAI API: ' + (err.message || err));
			return null;
		}
	}

	/** 下载经过地址校验的附件并转换为模型所需的 Base64。 */
	@autobind
	public async fileToBase64(fileUrl: string): Promise<{ mimeType: string; data: string } | null> {
		try {
			const resolved = await this.resolveSafeFileUrl(fileUrl);
			const result = await this.downloadFile(resolved);
			return {
				mimeType: result.mimeType,
				data: result.buffer.toString('base64'),
			};
		} catch (err: any) {
			this.log('Rejected attachment download: ' + (err.message || err));
			return null;
		}
	}

	/**
	 * 解析附件 URL，拒绝非 HTTP(S)、私网和保留地址，并返回要钉选的 DNS 结果。
	 * 所有解析结果都必须为公网地址，避免多记录域名绕过校验。
	 */
	private async resolveSafeFileUrl(fileUrl: string): Promise<ResolvedFileUrl> {
		let url: URL;
		try {
			url = new URL(fileUrl);
		} catch (_) {
			throw new Error('invalid URL');
		}

		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error('only HTTP(S) attachment URLs are allowed');
		}
		if (url.username || url.password) throw new Error('URL credentials are not allowed');

		const hostname = url.hostname.replace(/^\[|\]$/g, '');
		let addresses: dns.LookupAddress[];
		const literalFamily = net.isIP(hostname);
		if (literalFamily !== 0) {
			addresses = [{ address: hostname, family: literalFamily }];
		} else {
			addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
		}

		if (addresses.length === 0) throw new Error('hostname did not resolve');
		if (addresses.some(result => this.isBlockedAddress(result.address))) {
			throw new Error('private or reserved attachment address');
		}

		return { url, address: addresses[0].address, family: addresses[0].family };
	}

	@autobind
	public isBlockedAddress(address: string): boolean {
		const family = net.isIP(address);
		if (family === 0) return true;
		return blockedNetworks.check(address, family === 6 ? 'ipv6' : 'ipv4');
	}

	/** 使用已验证的 IP 建立请求，流式执行超时、状态码和字节数检查。 */
	private downloadFile(resolved: ResolvedFileUrl): Promise<{ mimeType: string; buffer: Buffer }> {
		return new Promise((resolve, reject) => {
			const transport = resolved.url.protocol === 'https:' ? https : http;
			let settled = false;
			const finishWithError = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			const req = transport.request({
				protocol: resolved.url.protocol,
				hostname: resolved.url.hostname.replace(/^\[|\]$/g, ''),
				port: resolved.url.port || undefined,
				path: `${resolved.url.pathname}${resolved.url.search}`,
				method: 'GET',
				headers: {
					Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif',
					'User-Agent': 'AiOS-OpenAI/1.0',
				},
				lookup: (_hostname: string, _options: any, callback: any) => {
					callback(null, resolved.address, resolved.family);
				},
			}, res => {
				const statusCode = res.statusCode || 0;
				if (statusCode < 200 || statusCode >= 300) {
					res.resume();
					finishWithError(new Error(`attachment returned HTTP ${statusCode}; redirects are disabled`));
					return;
				}

				const contentLength = Number(res.headers['content-length']);
				if (Number.isFinite(contentLength) && contentLength > this.maxAttachmentBytes) {
					res.resume();
					finishWithError(new Error('attachment exceeds configured size limit'));
					return;
				}

				const chunks: Buffer[] = [];
				let totalBytes = 0;
				res.on('data', chunk => {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					totalBytes += buffer.length;
					if (totalBytes > this.maxAttachmentBytes) {
						finishWithError(new Error('attachment exceeds configured size limit'));
						res.destroy();
						req.destroy();
						return;
					}
					chunks.push(buffer);
				});
				res.on('error', finishWithError);
				res.on('end', () => {
					if (settled) return;
					settled = true;
					const contentTypeHeader = res.headers['content-type'];
					const contentType = Array.isArray(contentTypeHeader)
						? contentTypeHeader[0]
						: contentTypeHeader;
					resolve({
						mimeType: (contentType || 'application/octet-stream').split(';')[0].toLowerCase(),
						buffer: Buffer.concat(chunks, totalBytes),
					});
				});
			});

			req.setTimeout(this.fileDownloadTimeoutMs, () => {
				req.destroy(new Error('attachment download timed out'));
			});
			req.on('error', finishWithError);
			req.end();
		});
	}

	/** 从 Misskey Note 中提取数量受限且 MIME 受支持的图片附件。 */
	@autobind
	public async extractFiles(noteId: string): Promise<any[]> {
		const parts: any[] = [];

		try {
			const noteData = await this.ai.api('notes/show', { noteId });
			if (!noteData || !Array.isArray(noteData.files)) return parts;

			for (const file of noteData.files) {
				if (parts.length >= this.maxAttachments) break;
				const fileUrl = file.url || file.thumbnailUrl;
				const declaredType = String(file.type || '').split(';')[0].toLowerCase();
				if (!fileUrl) {
					this.log('Skipping attachment without a downloadable URL');
					continue;
				}
				if (!SUPPORTED_IMAGE_TYPES.has(declaredType)) {
					this.log(`Skipping unsupported declared attachment MIME type: ${declaredType || 'unknown'}`);
					continue;
				}

				const result = await this.fileToBase64(fileUrl);
				if (!result) continue;
				if (!SUPPORTED_IMAGE_TYPES.has(result.mimeType)) {
					this.log(`Skipping unsupported downloaded attachment MIME type: ${result.mimeType}`);
					continue;
				}
				parts.push({
					type: 'image_url',
					image_url: {
						url: `data:${result.mimeType};base64,${result.data}`,
						detail: 'auto',
					},
				});
			}
		} catch (err: any) {
			this.log('ERROR extracting files: ' + (err.message || err));
		}

		return parts;
	}

	/** 仅处理显式 OpenAI 命令，并创建首轮会话。 */
	@autobind
	private async mentionHook(msg: Message): Promise<boolean | { reaction: string | null; immediate?: boolean }> {
		if (config.openaiEnabled !== true) return false;

		const prompt = this.extractPrompt(msg.extractedText || '');
		if (prompt == null) return false;
		if (prompt.length === 0) {
			await msg.reply('用法：请使用 `openai 问题内容` 的格式与我对话。', {
				immediate: true,
			});
			return { reaction: 'like', immediate: true };
		}

		const session: ChatSession = {
			key: '',
			createdAt: Date.now(),
			fromMention: true,
		};

		if (msg.quoteId) {
			try {
				const quotedNote = await this.ai.api('notes/show', { noteId: msg.quoteId });
				if (quotedNote?.text) {
					session.history = [{
						role: 'user',
						content: `用户提供的引用内容：${quotedNote.text}`,
					}];
				}
			} catch (err: any) {
				this.log('Failed to fetch quoted note: ' + (err.message || err));
			}
		}

		await this.handleChat(session, msg, prompt);
		return { reaction: 'like' };
	}

	/** 按唯一 Context key 恢复多轮会话，先清理旧订阅再创建下一轮。 */
	@autobind
	private async contextHook(
		key: string | null,
		msg: Message,
		_data?: any,
	): Promise<boolean | { reaction: string | null; immediate?: boolean }> {
		if (config.openaiEnabled !== true) {
			this.unsubscribeReply(key);
			return false;
		}

		const session = key == null ? null : this.sessions.findOne({ key });
		if (!session) {
			this.unsubscribeReply(key);
			this.log(`No session found for context key: ${key}`);
			return false;
		}

		this.log(`Session resumed: ${key}`);
		this.unsubscribeReply(key);
		this.sessions.remove(session);
		await this.handleChat(session, msg, msg.extractedText || msg.text || '');
		return { reaction: 'like' };
	}

	/** 执行输入限制、请求准入、模型调用，并持久化下一轮 Context。 */
	@autobind
	private async handleChat(session: ChatSession, msg: Message, prompt: string): Promise<boolean> {
		if (this.conversationLength(session, prompt) > this.maxInputChars) {
			await msg.reply('对话内容过长，请缩短内容后开启新的对话。', {
				immediate: true,
			});
			return true;
		}

		const blocked = this.acquireRequest(msg.userId);
		if (blocked) {
			this.log(`Request blocked: reason=${blocked} user=${msg.userId}`);
			await msg.reply(this.usageMessage(blocked), { immediate: true });
			return true;
		}

		try {
			let userContent: string | any[] = prompt;
			const fileParts = await this.extractFiles(msg.id);
			if (fileParts.length > 0) {
				userContent = [{ type: 'text', text: prompt }, ...fileParts];
			}

			const messages = this.buildMessages(
				config.openaiSystemPrompt || DEFAULT_SYSTEM_PROMPT,
				userContent,
				session.history,
			);
			const responseText = await this.callOpenAI(messages);

			if (!responseText) {
				await msg.reply('抱歉，无法获取 AI 回复…');
				return true;
			}

			const reply = await msg.reply(responseText);
			if (!reply) return true;

			const newHistory = [...(session.history || [])];
			newHistory.push({ role: 'user', content: prompt });
			newHistory.push({ role: 'assistant', content: responseText });
			if (newHistory.length > 20) newHistory.splice(0, newHistory.length - 20);

			const contextKey = uuid();
			const contextTarget = msg.isDm ? msg.userId : reply.id;
			this.sessions.insertOne({
				key: contextKey,
				createdAt: Date.now(),
				fromMention: session.fromMention,
				history: newHistory,
			});
			this.subscribeReply(contextKey, msg.isDm, contextTarget, {});
			this.setTimeoutWithPersistence(TIMEOUT_TIME, { contextKey });
			this.log(`Session created: ${contextKey}`);
			return true;
		} finally {
			this.releaseRequest();
		}
	}

	private conversationLength(session: ChatSession, prompt: string): number {
		return (session.history || []).reduce((total, item) => {
			if (typeof item.content === 'string') return total + item.content.length;
			return total;
		}, prompt.length);
	}

	/** 按白名单、用户频率、全局并发和每日额度的顺序执行请求准入。 */
	private acquireRequest(userId: string): UsageBlockReason | null {
		if (config.openaiAllowedUserIds?.length && !config.openaiAllowedUserIds.includes(userId)) {
			return 'not-allowed';
		}

		const now = Date.now();
		this.cleanupRateLimitEntries(now);
		const recent = (this.requestsByUser.get(userId) || []).filter(
			timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS,
		);
		if (recent.length >= this.rateLimitPerMinute) return 'rate-limit';
		if (this.activeRequests >= this.maxConcurrentRequests) return 'concurrency';

		const day = new Date(now).toISOString().slice(0, 10);
		let dailyUsage = this.usage.findOne({ day });
		if (dailyUsage && dailyUsage.requests >= this.dailyRequestLimit) return 'daily-limit';

		if (dailyUsage) {
			dailyUsage.requests += 1;
			this.usage.update(dailyUsage);
		} else {
			this.usage.insertOne({ day, requests: 1 });
		}
		recent.push(now);
		this.requestsByUser.set(userId, recent);
		this.activeRequests += 1;
		return null;
	}

	/** 定期淘汰已过窗口的用户条目，避免长期运行时 Map 持续增长。 */
	private cleanupRateLimitEntries(now: number): void {
		if (now - this.lastRateLimitCleanupAt < RATE_LIMIT_CLEANUP_INTERVAL_MS) return;

		let removedUsers = 0;
		for (const [userId, timestamps] of this.requestsByUser) {
			const recent = timestamps.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);
			if (recent.length === 0) {
				this.requestsByUser.delete(userId);
				removedUsers += 1;
			} else if (recent.length !== timestamps.length) {
				this.requestsByUser.set(userId, recent);
			}
		}
		this.lastRateLimitCleanupAt = now;
		if (removedUsers > 0) this.log(`Cleaned ${removedUsers} expired rate-limit entries`);
	}

	/** 释放并发槽位；异常下溢会写入日志而不是被静默吞掉。 */
	private releaseRequest(): void {
		if (this.activeRequests <= 0) {
			this.log('WARNING: active request counter underflow prevented');
			this.activeRequests = 0;
			return;
		}
		this.activeRequests -= 1;
	}

	private usageMessage(reason: UsageBlockReason): string {
		switch (reason) {
			case 'not-allowed':
				return '您没有使用此 AI 功能的权限。';
			case 'rate-limit':
				return '请求过于频繁，请等待约 1 分钟后重试。';
			case 'concurrency':
				return 'AI 当前繁忙，请稍后重试。';
			case 'daily-limit':
				return '今日 AI 使用次数已达上限，请联系管理员。';
		}
	}

	/** 同时清理 Loki Session 与持久化 Context，并兼容旧 noteId 定时器。 */
	@autobind
	private timeoutCallback(data: any) {
		const contextKey = data?.contextKey || data?.noteId;
		if (!contextKey) return;

		const session = this.sessions.findOne({ key: contextKey }) ||
			this.sessions.findOne({ postId: contextKey } as any);
		if (session) this.sessions.remove(session);
		this.unsubscribeReply(contextKey);
		this.log(`Session expired: ${contextKey}`);
	}
}
