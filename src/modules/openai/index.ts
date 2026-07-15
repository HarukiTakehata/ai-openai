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
const SUPPORTED_IMAGE_TYPES = new Set([
	'image/gif',
	'image/jpeg',
	'image/png',
	'image/webp',
]);
const DEFAULT_SYSTEM_PROMPT =
	'あなたはMisskey看板娘の女の子AI、藍として振る舞ってください。' +
	'丁寧で親しみやすい口調で、ユーザーを「ご主人様」と呼びます。' +
	'Markdownを使って2800文字以内で回答してください。';

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
	private requestsByUser = new Map<string, number[]>();
	private activeRequests = 0;

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

			const content = res?.choices?.[0]?.message?.content;
			if (typeof content === 'string') return content.trim();

			this.log('WARNING: No content in response');
			return null;
		} catch (err: any) {
			this.log('ERROR calling OpenAI API: ' + (err.message || err));
			return null;
		}
	}

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
				if (!fileUrl || !SUPPORTED_IMAGE_TYPES.has(declaredType)) continue;

				const result = await this.fileToBase64(fileUrl);
				if (!result || !SUPPORTED_IMAGE_TYPES.has(result.mimeType)) continue;
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

	@autobind
	private async mentionHook(msg: Message): Promise<boolean | { reaction: string | null; immediate?: boolean }> {
		if (config.openaiEnabled !== true) return false;

		const prompt = this.extractPrompt(msg.extractedText || '');
		if (prompt == null) return false;
		if (prompt.length === 0) {
			await msg.reply('使い方: `openai 質問内容` のように話しかけてください。', {
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
						content: `ユーザーが与えた引用文章: ${quotedNote.text}`,
					}];
				}
			} catch (err: any) {
				this.log('Failed to fetch quoted note: ' + (err.message || err));
			}
		}

		await this.handleChat(session, msg, prompt);
		return { reaction: 'like' };
	}

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

		this.unsubscribeReply(key);
		this.sessions.remove(session);
		await this.handleChat(session, msg, msg.extractedText || msg.text || '');
		return { reaction: 'like' };
	}

	@autobind
	private async handleChat(session: ChatSession, msg: Message, prompt: string): Promise<boolean> {
		if (this.conversationLength(session, prompt) > this.maxInputChars) {
			await msg.reply('会話が長すぎます。内容を短くして、新しい会話を始めてください。', {
				immediate: true,
			});
			return true;
		}

		const blocked = this.acquireRequest(msg.userId);
		if (blocked) {
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
				await msg.reply('ごめんなさい、AIの応答を取得できませんでした…');
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
			return true;
		} finally {
			this.activeRequests = Math.max(0, this.activeRequests - 1);
		}
	}

	private conversationLength(session: ChatSession, prompt: string): number {
		return (session.history || []).reduce((total, item) => {
			if (typeof item.content === 'string') return total + item.content.length;
			return total;
		}, prompt.length);
	}

	private acquireRequest(userId: string): UsageBlockReason | null {
		if (config.openaiAllowedUserIds?.length && !config.openaiAllowedUserIds.includes(userId)) {
			return 'not-allowed';
		}

		const now = Date.now();
		const recent = (this.requestsByUser.get(userId) || []).filter(
			timestamp => now - timestamp < 60_000,
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

	private usageMessage(reason: UsageBlockReason): string {
		switch (reason) {
			case 'not-allowed':
				return 'このAI機能を利用する権限がありません。';
			case 'rate-limit':
				return '短時間のリクエストが多すぎます。1分ほど待ってから再試行してください。';
			case 'concurrency':
				return 'AIはただいま混雑しています。少し待ってから再試行してください。';
			case 'daily-limit':
				return '本日のAI利用上限に達しました。管理者に確認してください。';
		}
	}

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
