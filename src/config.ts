type Config = {
	host: string;
	i: string;
	master?: string;
	wsUrl: string;
	apiUrl: string;
	keywordEnabled: boolean;
	reversiEnabled: boolean;
	notingEnabled: boolean;
	chartEnabled: boolean;
	serverMonitoring: boolean;
	mecab?: string;
	mecabDic?: string;
	memoryDir?: string;
	// OpenAI 兼容 API 配置
	openaiEnabled?: boolean;
	openaiApiKey?: string;
	openaiBaseUrl?: string;
	openaiModel?: string;
	openaiSystemPrompt?: string;
	openaiMaxTokens?: number;
	openaiTemperature?: number;
	openaiRequestTimeoutMs?: number;
	openaiFileDownloadTimeoutMs?: number;
	openaiMaxAttachmentBytes?: number;
	openaiMaxAttachments?: number;
	openaiMaxInputChars?: number;
	openaiRateLimitPerMinute?: number;
	openaiMaxConcurrentRequests?: number;
	openaiDailyRequestLimit?: number;
	openaiAllowedUserIds?: string[];
};

const config = require('../config.json');

config.wsUrl = config.host.replace('http', 'ws');
config.apiUrl = config.host + '/api';

export default config as Config;
