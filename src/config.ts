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
	openaiApiKey: string;
	openaiBaseUrl?: string;
	openaiModel?: string;
	openaiSystemPrompt?: string;
	openaiMaxTokens?: number;
	openaiTemperature?: number;
	// OpenAI 兼容 API 随机聊天配置
	openaiRandomTalkEnabled?: boolean;
	openaiRandomTalkProbability?: number;
	openaiRandomTalkIntervalMinutes?: number;
};

const config = require('../config.json');

config.wsUrl = config.host.replace('http', 'ws');
config.apiUrl = config.host + '/api';

export default config as Config;
