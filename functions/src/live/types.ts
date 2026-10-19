export type LiveProvider = "assemblyai" | "openai";

/**
 * Everything the app needs to open one live transcription WebSocket.
 * `url` is ready to connect and `headers` go on the upgrade request, so the
 * client never needs a provider API key or provider-specific auth logic.
 */
export interface LiveSessionGrant {
  provider: LiveProvider;
  url: string;
  headers: Record<string, string>;
  /** PCM16 mono sample rate the provider expects. */
  sampleRate: number;
  /** Seconds this session may run before the provider closes it. */
  maxSessionSeconds?: number;
}

/** Provider refused or failed to create a session. */
export class LiveProviderError extends Error {}
