import {
  Agent,
  routeAgentRequest,
  type Connection,
  type ConnectionContext,
} from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  type VoiceTurnContext,
} from "@cloudflare/voice";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { authenticateToken, type AuthUser } from "./auth";
import { buildProposalTools } from "./proposalTools";
import { DeepgramSTT, DispatchTTS } from "./deepgram";

interface Env {
  AI: Ai;
  VoiceAgent: DurableObjectNamespace;
  APP_URL: string;
  MCP_URL: string;
  GEMINI_API_KEY?: string; // optional fallback when Workers AI quota is exceeded
  DEEPGRAM_API_KEY?: string; // when set, STT/TTS use Deepgram (own quota) instead of Workers AI
}

// Runtime provider toggles fetched from the main app's admin panel.
type VoiceFlags = { gemini: boolean; deepgram: boolean; workersai_dave: boolean };
const DEFAULT_FLAGS: VoiceFlags = { gemini: true, deepgram: true, workersai_dave: true };

/** Fetch the voice-relevant provider flags from the main app (defaults to all-on). */
async function fetchVoiceFlags(appUrl: string, token: string): Promise<VoiceFlags> {
  try {
    const resp = await fetch(`${appUrl}/api/voice-config`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return { ...DEFAULT_FLAGS };
    const body: any = await resp.json();
    const d = body?.data;
    if (!body?.success || !d) return { ...DEFAULT_FLAGS };
    return {
      gemini: typeof d.gemini === "boolean" ? d.gemini : true,
      deepgram: typeof d.deepgram === "boolean" ? d.deepgram : true,
      workersai_dave: typeof d.workersai_dave === "boolean" ? d.workersai_dave : true,
    };
  } catch (err) {
    console.error("[fetchVoiceFlags] error", err);
    return { ...DEFAULT_FLAGS };
  }
}

const SYSTEM_PROMPT = `You are the ProposalForge voice assistant. You help the signed-in user manage their business proposals by voice.

You have tools to list, search, get details of, create, send, and generate a PDF of proposals, report engagement analytics, and look up current market pricing from the web (lookup_pricing). USE THEM — never make up proposal data or prices.

When the user is unsure what to charge or asks what something costs, call lookup_pricing first, tell them the figure, then use it in the proposal.

Rules:
- Keep responses SHORT and conversational; this is spoken aloud. No Markdown or code blocks.
- When creating a proposal, confirm the title and at least one line item (name + price) before calling create_proposal.
- Before sending a proposal, ALWAYS confirm the recipient email and which proposal with the user first.
- Amounts are spoken; convert words to numbers (e.g. "four thousand" -> 4000).
- Summarize tool results naturally; don't read long lists or full numbers verbatim.`;

const BaseVoiceAgent = withVoice(Agent);

export class VoiceAgent extends BaseVoiceAgent<Env> {
  // Live provider toggles (refreshed per call in onConnect from the admin panel).
  private providerFlags: VoiceFlags = { ...DEFAULT_FLAGS };

  // TTS dispatches Deepgram vs Workers AI per spoken reply based on the toggle,
  // so it switches at runtime without a redeploy. STT switches via
  // createTranscriber() below. `tts` is required as a class field by the SDK.
  tts = new DispatchTTS({
    ai: this.env.AI,
    deepgramKey: this.env.DEEPGRAM_API_KEY,
    useDeepgram: () => this.providerFlags.deepgram && !!this.env.DEEPGRAM_API_KEY,
  });

  // Per-connection auth, populated on connect from the ?token= query param.
  private authByConn = new Map<string, { user: AuthUser; token: string }>();

  /** SDK hook: pick the STT provider per connection (after onConnect loads flags). */
  createTranscriber(_connection: Connection) {
    const useDeepgram = this.providerFlags.deepgram && !!this.env.DEEPGRAM_API_KEY;
    console.log(`[STT] provider = ${useDeepgram ? "Deepgram" : "Cloudflare Workers AI (Dave)"}`);
    return useDeepgram
      ? new DeepgramSTT(this.env.DEEPGRAM_API_KEY as string)
      : new WorkersAIFluxSTT(this.env.AI);
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    try {
      const token = new URL(ctx.request.url).searchParams.get("token");
      const user = await authenticateToken(token, this.env.APP_URL);
      if (user && token) {
        this.authByConn.set(connection.id, { user, token });
        // Load current provider toggles for this call.
        this.providerFlags = await fetchVoiceFlags(this.env.APP_URL, token);
        console.log(
          `[FLAGS] gemini=${this.providerFlags.gemini} deepgram=${this.providerFlags.deepgram} workersai_dave=${this.providerFlags.workersai_dave}`,
        );
      }
    } catch (err) {
      console.error("[onConnect] auth error", err);
    }
    // Preserve base/voice connection setup.
    await (Agent.prototype as any).onConnect?.call(this, connection, ctx);
  }

  async onCallStart(connection: Connection) {
    const auth = this.authByConn.get(connection.id);
    const greeting = auth
      ? `Hi ${auth.user.fullName || "there"}! I'm your ProposalForge assistant. I can list, search, create, or send your proposals, and report how they're performing. What would you like to do?`
      : "Hi! I couldn't verify your sign-in. Please sign in on the website, then start the call again so I can access your proposals.";
    await this.speak(connection, greeting);
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    console.log(`[STT] 🎤 transcript: "${transcript}"`);

    const auth = this.authByConn.get(context.connection.id);
    if (!auth) {
      return "I can't access your proposals because you're not signed in. Please sign in on the website and start a new call.";
    }

    const tools = buildProposalTools(this.env.MCP_URL, auth.token, this.env.GEMINI_API_KEY);
    const params = {
      system: SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: transcript },
      ],
      tools,
      stopWhen: stepCountIs(5),
    };
    const fallbackMsg = "Sorry, I couldn't process that. Could you try again?";

    // LLM provider order is gated by the runtime admin toggles.
    const useGemini = this.providerFlags.gemini && !!this.env.GEMINI_API_KEY;
    const useWorkersAI = this.providerFlags.workersai_dave;

    // Primary: Google Gemini (when enabled). Retry transient overloads.
    if (useGemini) {
      const google = createGoogleGenerativeAI({ apiKey: this.env.GEMINI_API_KEY as string });
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { text } = await generateText({
            model: google("gemini-flash-latest"),
            ...params,
          });
          console.log(`[LLM] 🧠 served via Gemini (gemini-flash-latest, attempt ${attempt})`);
          return text || fallbackMsg;
        } catch (err: any) {
          console.error(`[onTurn] Gemini attempt ${attempt} failed:`, err?.message || err);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt));
        }
      }
    }

    // Fallback: Workers AI on Dave (when enabled).
    if (useWorkersAI) {
      try {
        const ai = createWorkersAI({ binding: this.env.AI });
        const { text } = await generateText({
          model: ai("@cf/google/gemma-4-26b-a4b-it"),
          ...params,
        });
        console.log("[LLM] 🧠 served via Cloudflare Workers AI — Dave (gemma-4-26b)");
        return text || fallbackMsg;
      } catch (err: any) {
        console.error("[onTurn] Workers AI fallback failed:", err?.message || err);
      }
    }

    if (!useGemini && !useWorkersAI) {
      console.error("[onTurn] no LLM enabled (gemini + workersai_dave both off)");
    }
    return "Sorry, I'm having trouble reaching the AI service right now. Please try again in a moment.";
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
