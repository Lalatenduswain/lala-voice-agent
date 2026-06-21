/**
 * Deepgram-direct STT/TTS providers for @cloudflare/voice.
 *
 * These talk to Deepgram's own API with our own API key, so the speech
 * pipeline no longer depends on the Cloudflare Workers AI Neuron daily quota.
 * Workers AI's built-in voice models (Flux / Aura) are literally Deepgram under
 * the hood, so this is the same quality on a separate, independent quota.
 *
 * Audio contract (must match what @cloudflare/voice expects):
 *   - STT input : 16 kHz, mono, 16-bit little-endian PCM (linear16)
 *   - TTS output: MP3 (the SDK's default `audioFormat`, decoded via decodeAudioData)
 */

import { WorkersAITTS } from "@cloudflare/voice";
import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions,
  TTSProvider,
} from "@cloudflare/voice";

const DG_BASE = "https://api.deepgram.com";
const SAMPLE_RATE = 16000;

/** Streaming speech-to-text via Deepgram's live Listen API. */
export class DeepgramSTT implements Transcriber {
  #apiKey: string;
  #model: string;

  constructor(apiKey: string, options?: { model?: string }) {
    this.#apiKey = apiKey;
    this.#model = options?.model ?? "nova-2";
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new DeepgramSTTSession(this.#apiKey, this.#model, options);
  }
}

class DeepgramSTTSession implements TranscriberSession {
  #onInterim?: (text: string) => void;
  #onUtterance?: (transcript: string) => void;
  #ws: WebSocket | null = null;
  #connected = false;
  #closed = false;
  #pending: ArrayBuffer[] = [];
  #finals: string[] = [];
  #keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(apiKey: string, model: string, options?: TranscriberSessionOptions) {
    this.#onInterim = options?.onInterim;
    this.#onUtterance = options?.onUtterance;
    void this.#connect(apiKey, model, options?.language ?? "en");
  }

  async #connect(apiKey: string, model: string, language: string) {
    try {
      const qs = new URLSearchParams({
        model,
        language,
        encoding: "linear16",
        sample_rate: String(SAMPLE_RATE),
        channels: "1",
        interim_results: "true",
        smart_format: "true",
        punctuate: "true",
        endpointing: "300",
      });
      // Cloudflare Workers make outbound WebSockets via fetch() + Upgrade header.
      const resp = await fetch(`${DG_BASE}/v1/listen?${qs.toString()}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Token ${apiKey}`,
        },
      });
      const ws = resp.webSocket;
      if (!ws) {
        console.error(
          `[DeepgramSTT] No WebSocket in response (status ${resp.status})`,
        );
        return;
      }
      if (this.#closed) {
        ws.accept();
        ws.close();
        return;
      }
      ws.accept();
      this.#ws = ws;
      this.#connected = true;
      console.log(`[STT] ✅ Deepgram connected (model=${model})`);

      ws.addEventListener("message", (event) => this.#handleMessage(event));
      ws.addEventListener("close", () => {
        this.#connected = false;
      });
      ws.addEventListener("error", (event) => {
        console.error("[DeepgramSTT] WebSocket error:", event);
        this.#connected = false;
      });

      // Flush any audio buffered before the socket opened.
      for (const chunk of this.#pending) ws.send(chunk);
      this.#pending = [];

      // Deepgram closes idle sockets (~10s); keep it warm during silence.
      this.#keepAlive = setInterval(() => {
        if (this.#connected && this.#ws) {
          try {
            this.#ws.send(JSON.stringify({ type: "KeepAlive" }));
          } catch {}
        }
      }, 8000);
    } catch (err) {
      console.error("[DeepgramSTT] Connection error:", err);
    }
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;
    if (this.#connected && this.#ws) this.#ws.send(chunk);
    else this.#pending.push(chunk);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = [];
    if (this.#keepAlive) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = null;
    }
    if (this.#ws) {
      try {
        this.#ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {}
      try {
        this.#ws.close();
      } catch {}
      this.#ws = null;
    }
    this.#connected = false;
  }

  #handleMessage(event: MessageEvent) {
    if (this.#closed) return;
    try {
      const data = typeof event.data === "string" ? JSON.parse(event.data) : null;
      if (!data || data.type !== "Results") return;
      const transcript: string =
        data.channel?.alternatives?.[0]?.transcript ?? "";

      if (data.is_final) {
        if (transcript) this.#finals.push(transcript);
        // speech_final marks the end of an utterance (endpointing fired).
        if (data.speech_final) {
          const full = this.#finals.join(" ").trim();
          this.#finals = [];
          if (full) this.#onUtterance?.(full);
        }
      } else if (transcript) {
        // Interim: show accumulated finals plus the unstable tail.
        const live = [...this.#finals, transcript].join(" ").trim();
        if (live) this.#onInterim?.(live);
      }
    } catch {}
  }
}

/** Text-to-speech via Deepgram's Speak API. Returns MP3 bytes. */
export class DeepgramTTS implements TTSProvider {
  #apiKey: string;
  #model: string;

  constructor(apiKey: string, options?: { model?: string }) {
    this.#apiKey = apiKey;
    this.#model = options?.model ?? "aura-asteria-en";
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const qs = new URLSearchParams({ model: this.#model, encoding: "mp3" });
    const resp = await fetch(`${DG_BASE}/v1/speak?${qs.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      ...(signal ? { signal } : {}),
    });
    if (!resp.ok) {
      console.error(
        `[TTS] ❌ Deepgram speak failed (${resp.status}): ${await resp.text().catch(() => "")}`,
      );
      return null;
    }
    const buf = await resp.arrayBuffer();
    console.log(`[TTS] 🔊 Deepgram synthesized ${buf.byteLength} bytes (model=${this.#model})`);
    return buf;
  }
}

/**
 * TTS that chooses Deepgram vs Workers AI per-call based on a live predicate.
 * The SDK calls `this.tts.synthesize()` for every spoken reply, so reading the
 * current admin toggle here makes TTS switchable at runtime (no redeploy).
 */
export class DispatchTTS implements TTSProvider {
  #deepgram: DeepgramTTS | null;
  #workersai: WorkersAITTS;
  #useDeepgram: () => boolean;

  constructor(opts: { ai: Ai; deepgramKey?: string; useDeepgram: () => boolean }) {
    this.#deepgram = opts.deepgramKey ? new DeepgramTTS(opts.deepgramKey) : null;
    this.#workersai = new WorkersAITTS(opts.ai);
    this.#useDeepgram = opts.useDeepgram;
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    if (this.#deepgram && this.#useDeepgram()) {
      return this.#deepgram.synthesize(text, signal);
    }
    console.log("[TTS] 🔊 Cloudflare Workers AI (Dave) TTS");
    return this.#workersai.synthesize(text, signal);
  }
}
