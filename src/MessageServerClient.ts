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

	/**
	 * BackwardSegment (= ストリーム開始前の過去メッセージ) の取得上限件数。
	 * 0 以下なら過去メッセージは取得しない。
	 */
	public pastMessagesLimit = 100;

	constructor(private readonly messageServerUrl: string) {}

	public connect() {
		this.disconnect();
		this.fetchChunkedEntryStreamByPolling();
	}

	public disconnect() {
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
		while (!this.abortController?.signal?.aborted) {
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
		const segmentUri = chunk.segment?.uri;
		if (segmentUri === undefined) return;

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
		const response = await fetch(chunk.uri);
		for await (const message of decodeChunkStream(
			proto.ChunkedMessageSchema,
			response.body as ReadableStream<Uint8Array>,
		)) {
			this.onChunkedMessage(message);
		}
	};

	private onPreviousChunkedEntry = async (chunk: MessageSegment) => {
		// previous は backward と二重に届くケースがあるので無視する
	};

	private onNextChunkedEntry = (chunk: ChunkedEntry_ReadyForNext) => {
		this.nextStreamAt = chunk.at;
	};
}
