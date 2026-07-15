import * as WebSocket from 'ws';

export class StreamingApi {
	private ws: WebSocket;

	constructor() {
		this.ws = new WebSocket('ws://localhost/streaming');
	}

	public async waitForMainChannelConnected() {
		// Wait for connection to be established
		return new Promise<void>((resolve) => {
			this.ws.on('open', () => resolve());
		});
	}

	public send(message: any) {
		this.ws.send(JSON.stringify(message));
	}
}
