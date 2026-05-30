import { EventEmitter } from "./EventEmitter";
import { MessageServerClient } from "./MessageServerClient";
import { WSAPIClient } from "./WSAPIClient";
import type { PlatformAPI } from "./platform/PlatformAPI";
import type * as proto from "./proto";

export interface NicoliveClientConfig {
	/**
	 *  配信ID(`"lvXXXXXXXX"`)
	 */
	liveId: string;

	/**
	 * 接続時に取得する過去メッセージ (= ストリーム先頭の BackwardSegment) の上限件数。
	 * 件数は chat 以外 (state / gift など) も含む「生メッセージ」単位で数えるため、
	 * 実際に pastChats へ渡る chat の件数はこれより少なくなる。
	 * 0 以下にすると過去メッセージは取得しない。デフォルト 200。
	 */
	pastMessagesLimit?: number;
}

export namespace NicoliveClientConfig {
	export const Default: Required<NicoliveClientConfig> = {
		liveId: "",
		pastMessagesLimit: 200,
	};
}

type EventMap = {
	message: [message: proto.NicoliveMessage, meta?: proto.ChunkedMessage_Meta];
	changeState: [message: proto.NicoliveState, meta?: proto.ChunkedMessage_Meta];

	chat: [message: proto.Chat, meta?: proto.ChunkedMessage_Meta];
	/**
	 * 接続時に取得した過去コメント (BackwardSegment) の chat メッセージ一覧。
	 * pastMessagesLimit に制限した分だけ、一度だけ発火する。
	 */
	pastChats: [messages: proto.Chat[]];
	simpleNotification: [
		message: proto.SimpleNotification,
		meta?: proto.ChunkedMessage_Meta,
	];
	gift: [message: proto.Gift, meta?: proto.ChunkedMessage_Meta];
	nicoad: [message: proto.Nicoad, meta?: proto.ChunkedMessage_Meta];
	gameUpdate: [message: proto.GameUpdate, meta?: proto.ChunkedMessage_Meta];
	tagUpdated: [message: proto.TagUpdated, meta?: proto.ChunkedMessage_Meta];
	moderatorUpdated: [
		message: proto.ModeratorUpdated,
		meta?: proto.ChunkedMessage_Meta,
	];
	ssngUpdated: [message: proto.SSNGUpdated, meta?: proto.ChunkedMessage_Meta];
	overflowedChat: [message: proto.Chat, meta?: proto.ChunkedMessage_Meta];
};

/**
 * エントリポイントとなるクラス。配信の情報取得やコメントの取得などのAPIを提供する。
 */
export class NicoliveClientCore extends EventEmitter<EventMap> {
	private readonly config = NicoliveClientConfig.Default;
	private wsApiClient: WSAPIClient | null = null;
	private messageServerUri: string | null = null;
	private messageServerClient: MessageServerClient | null = null;

	/**
	 * NicoLiveClientのインスタンスを生成する
	 * @param config
	 * @param config.liveId 配信ID(`"lvXXXXXXXX"`)
	 * @param platformAPI PlatformAPIのインスタンス
	 */
	constructor(
		config: NicoliveClientConfig,
		private platformAPI: PlatformAPI,
	) {
		super();
		this.config = Object.assign({}, NicoliveClientConfig.Default, config);
	}

	/**
	 * 配信のWebSocketAPI及びコメントサーバーへ接続する
	 */
	connect() {
		this.disconnect();

		const wsApiClient = new WSAPIClient(this.config.liveId, this.platformAPI);
		wsApiClient.onMessageServerMessage = (message) => {
			this.setMessageServerUri(message.data.viewUri);
		};
		wsApiClient.connect();
		this.wsApiClient = wsApiClient;
	}

	/**
	 * 配信のWebSocketAPI及びコメントサーバーとの接続を切断する
	 */
	disconnect() {
		this.disconnectFromMessageServer();
		if (this.wsApiClient) {
			this.wsApiClient.disconnect();
		}
	}

	private setMessageServerUri(uri: string) {
		this.messageServerUri = uri;
		this.connectToMessageServer();
	}

	private connectToMessageServer() {
		this.disconnectFromMessageServer();

		const messageServerUri = this.messageServerUri;
		if (messageServerUri === null) {
			throw new Error("messageServerUri is not set");
		}

		const messageServerClient = new MessageServerClient(messageServerUri);
		messageServerClient.pastMessagesLimit = this.config.pastMessagesLimit;

		messageServerClient.onChunkedMessage = (message) => {
			switch (message.payload.case) {
				case "message": {
					this.onNicoliveMessage(message.payload.value, message.meta);
					break;
				}

				case "state": {
					this.emit("changeState", message.payload.value, message.meta);
					break;
				}

				case "signal": {
					break;
				}
			}
		};

		messageServerClient.onBackwardChunkedMessages = (messages) => {
			// chat メッセージだけ抜き出して 1 度だけ emit する
			const chats: proto.Chat[] = [];
			for (const m of messages) {
				if (m.payload.case !== "message") continue;
				const data = m.payload.value.data;
				if (data.case === "chat") chats.push(data.value);
			}
			if (chats.length > 0) this.emit("pastChats", chats);
		};

		messageServerClient.connect();
		// upstream バグ修正: ここで保持しないと disconnectFromMessageServer が効かない
		this.messageServerClient = messageServerClient;
	}

	private onNicoliveMessage(
		message: proto.NicoliveMessage,
		meta?: proto.ChunkedMessage_Meta,
	) {
		this.emit("message", message, meta);

		switch (message.data.case) {
			case "chat":
				this.emit("chat", message.data.value, meta);
				break;

			case "simpleNotification":
				this.emit("simpleNotification", message.data.value, meta);
				break;

			case "gift":
				this.emit("gift", message.data.value, meta);
				break;

			case "nicoad":
				this.emit("nicoad", message.data.value, meta);
				break;

			case "gameUpdate":
				this.emit("gameUpdate", message.data.value, meta);
				break;

			case "tagUpdated":
				this.emit("tagUpdated", message.data.value, meta);
				break;

			case "moderatorUpdated":
				this.emit("moderatorUpdated", message.data.value, meta);
				break;

			case "ssngUpdated":
				this.emit("ssngUpdated", message.data.value, meta);
				break;

			case "overflowedChat":
				this.emit("overflowedChat", message.data.value, meta);
				break;
		}
	}

	private disconnectFromMessageServer() {
		if (this.messageServerClient) {
			this.messageServerClient.disconnect();
			this.messageServerClient = null;
		}
	}
}
