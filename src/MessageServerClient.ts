import { fromBinary } from "@bufbuild/protobuf";
import { type ReadableStream, decodeChunkStream } from "./ChunkStream";
import type {
	BackwardSegment,
	ChunkedEntry_ReadyForNext,
	ChunkedMessage,
	MessageSegment,
} from "./proto";
import * as proto from "./proto";

export class MessageServerClient {
	private nextStreamAt: bigint | "now" = "now";
	private abortController: AbortController | null = null;
	private aborted = false;
	// BackwardSegment (= 過去メッセージ) は接続直後の最初の 1 度だけ処理する。
	// ポーリングを繰り返すと毎回 backward エントリが届くため、フラグで二重発火を防ぐ。
	private backwardFetched = false;

	/**
	 * BackwardSegment (= ストリーム開始前の過去メッセージ) の取得上限件数。
	 * chat 以外も含む生メッセージ単位で末尾 N 件に絞る。
	 * 0 以下なら過去メッセージは取得しない。
	 */
	public pastMessagesLimit = 200;

	constructor(private readonly messageServerUrl: string) {}

	public connect() {
		this.disconnect();
		this.aborted = false;
		this.backwardFetched = false;
		this.nextStreamAt = "now";
		this.abortController = new AbortController();
		this.fetchChunkedEntryStreamByPolling();
	}

	public disconnect() {
		this.aborted = true;
		this.abortController?.abort();
		this.abortController = null;
	}

	public onChunkedMessage = (message: proto.ChunkedMessage) => {};

	/**
	 * ストリーム開始時に届く BackwardSegment (= 過去メッセージ) を受信した時の callback。
	 * pastMessagesLimit に制限した上で渡される。
	 */
	public onBackwardChunkedMessages = (messages: ChunkedMessage[]) => {};

	private getOrCreateAbortController() {
		if (this.abortController === null) {
			this.abortController = new AbortController();
		}
		return this.abortController;
	}

	private async fetchChunkedEntryStreamByPolling() {
		// 切断判定は aborted フラグで行う。abortController を null に戻しても
		// ループが再開しないようにし、disconnect() 後に確実にポーリングを止める。
		while (!this.aborted) {
			try {
				const abortController = this.getOrCreateAbortController();

				const response = await fetch(
					`${this.messageServerUrl}?at=${this.nextStreamAt}`,
					{
						signal: abortController.signal,
						headers: {
							Priority: "u=1, i",
						},
					},
				);

				for await (const chunk of decodeChunkStream(
					proto.ChunkedEntrySchema,
					response.body as ReadableStream<Uint8Array>,
				)) {
					const entry = chunk.entry;
					switch (entry.case) {
						case "backward":
							this.onBackwardChunkedEntry(entry.value);
							break;

						case "segment":
							this.onSegmentChunkedEntry(entry.value);
							break;

						case "previous":
							this.onPreviousChunkedEntry(entry.value);
							break;

						case "next":
							this.onNextChunkedEntry(entry.value);
							break;
					}
				}
			} catch (ignored) {}
		}
	}

	private onBackwardChunkedEntry = async (chunk: BackwardSegment) => {
		// snapshot は配信全体の StateSnapshot で大量データになり得るので無視する。
		// segment は「ストリーム開始直前の最新セグメント」で、配信再開時のキャッチアップに
		// ちょうどよい粒度の過去メッセージが入っている。
		if (this.pastMessagesLimit <= 0) return;
		// 接続後の最初の 1 度だけ過去メッセージを取得する
		if (this.backwardFetched) return;
		const segmentUri = chunk.segment?.uri;
		if (segmentUri === undefined) return;
		this.backwardFetched = true;

		try {
			const response = await fetch(segmentUri, {
				signal: this.abortController?.signal,
			});
			const buffer = new Uint8Array(await response.arrayBuffer());
			const packed = fromBinary(proto.PackedSegmentSchema, buffer);
			// セグメント内に多数あった場合に備えて末尾 N 件に絞る
			const messages =
				packed.messages.length > this.pastMessagesLimit
					? packed.messages.slice(-this.pastMessagesLimit)
					: packed.messages;
			if (messages.length > 0) {
				this.onBackwardChunkedMessages(messages);
			}
		} catch (ignored) {
			// 過去メッセージ取得失敗はライブ配信の取得自体には影響させない
		}
	};

	private onSegmentChunkedEntry = async (chunk: MessageSegment) => {
		// segment は長時間ストリームし続けるので、abort signal を渡し
		// disconnect() 後にメッセージを流し続けないようにする。
		try {
			const response = await fetch(chunk.uri, {
				signal: this.abortController?.signal,
			});
			for await (const message of decodeChunkStream(
				proto.ChunkedMessageSchema,
				response.body as ReadableStream<Uint8Array>,
			)) {
				if (this.aborted) break;
				this.onChunkedMessage(message);
			}
		} catch (ignored) {
			// 切断 (abort) 等によるエラーは無視する
		}
	};

	private onPreviousChunkedEntry = async (chunk: MessageSegment) => {
		// previous は backward と二重に届くケースがあるので無視する
	};

	private onNextChunkedEntry = (chunk: ChunkedEntry_ReadyForNext) => {
		this.nextStreamAt = chunk.at;
	};
}
