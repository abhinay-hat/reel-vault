import { Connector, IngestResult } from "./types";
export class MessagingApiConnector implements Connector {
  name = "instagram-messaging-api";
  async ingest(): Promise<IngestResult> {
    throw new Error("MessagingApiConnector not configured: requires a business account + Meta App Review.");
  }
}
