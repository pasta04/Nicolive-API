import axios from 'axios';
import { AbortController } from "node-abort-controller";
import { decodeChunkStream } from "./ChunkStream";
import type {
	BackwardSegment,
	ChunkedEntry_ReadyForNext,
	MessageSegment,
} from "./proto";
import * as proto from "./proto";

export class MessageServerClient {
	private nextStreamAt: bigint | "now" = "now";
	private abortController: AbortController = new AbortController();

	constructor(private readonly messageServerUrl: string) {}

	public async connect() {
		console.log("[MessageServerClient] connect");
		this.disconnect();
		this.abortController = new AbortController();
		this.fetchChunkedEntryStreamByPolling();
	}

	public async disconnect() {
		console.log(`[MessageServerClient] disconnect`);
		this.abortController.abort();
	}


	public onChunkedMessage = (message: proto.ChunkedMessage) => {};

	private getOrCreateAbortController() {
	
		if (this.abortController === null) {
			this.abortController = new AbortController();
		}
		return this.abortController;
	}

	private async fetchChunkedEntryStreamByPolling() {
		console.log("[fetchChunkedEntryStreamByPolling] start");
		while (!this.abortController.signal.aborted) {
			try {
				const abortController = this.getOrCreateAbortController();

				const url = `${this.messageServerUrl}?at=${this.nextStreamAt}`;
				console.log(`[fetchChunkedEntryStreamByPolling] ${url}`);
				const response = (await axios.get(url,
					{
						signal: abortController.signal,
						headers: {
							Priority: "u=1, i",
						},
						responseType: 'stream',
					},
				));

				for await (const data of response.data) {
					const chunks = await decodeChunkStream(proto.ChunkedEntrySchema,	data);
					for(const chunk of chunks) {
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

				}
			} catch (ignored) {}
		}
		console.log("[fetchChunkedEntryStreamByPolling] end");
	}

	private onBackwardChunkedEntry = async (chunk: BackwardSegment) => {
		// const snapshotUri = chunk.snapshot?.uri;
		// if (snapshotUri !== undefined) {
		// 	// TODO: 謎
		// }
		//
		// const segmentUri = chunk.segment?.uri;
		// if (segmentUri !== undefined) {
		// 	console.log(await getPackedSegment(segmentUri));
		// }
	};

	private onSegmentChunkedEntry = async (chunk: MessageSegment) => {
		const response = await axios.get(chunk.uri, {
			signal: this.abortController?.signal,
			responseType: 'stream'
		});
		for await (const data of response.data) {
			const tmps = await decodeChunkStream(proto.ChunkedMessageSchema,	data);
			for(const message of tmps) {
				this.onChunkedMessage(message);	
			}
		}

	};

	private onPreviousChunkedEntry = async (chunk: MessageSegment) => {
		// 不明: 前回のStreamにて"segment"として配信済みのチャンクが"previous"として届いている?
		// const response = await axios.get(chunk.uri, {
		// 	responseType: "arraybuffer",
		// });
		//
		// const messages = decodeChunks(proto.ChunkedMessageSchema, response.data);
		// for (const message of messages) {
		// 	console.log(
		// 		JSON.stringify(toJson(proto.ChunkedMessageSchema, message), null, 2),
		// 	);
		// }
	};

	private onNextChunkedEntry = (chunk: ChunkedEntry_ReadyForNext) => {
		this.nextStreamAt = chunk.at;
	};
}
