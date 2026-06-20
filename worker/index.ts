import {
  Agent,
  routeAgentRequest,
  type Connection,
  type ConnectionContext,
} from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type VoiceTurnContext,
} from "@cloudflare/voice";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { authenticateToken, type AuthUser } from "./auth";
import { buildProposalTools } from "./proposalTools";

interface Env {
  AI: Ai;
  VoiceAgent: DurableObjectNamespace;
  APP_URL: string;
  MCP_URL: string;
  GEMINI_API_KEY?: string; // optional fallback when Workers AI quota is exceeded
}

const SYSTEM_PROMPT = `You are the ProposalForge voice assistant. You help the signed-in user manage their business proposals by voice.

You have tools to list, search, get details of, create, and send proposals, and to report engagement analytics. USE THEM — never make up proposal data.

Rules:
- Keep responses SHORT and conversational; this is spoken aloud. No Markdown or code blocks.
- When creating a proposal, confirm the title and at least one line item (name + price) before calling create_proposal.
- Before sending a proposal, ALWAYS confirm the recipient email and which proposal with the user first.
- Amounts are spoken; convert words to numbers (e.g. "four thousand" -> 4000).
- Summarize tool results naturally; don't read long lists or full numbers verbatim.`;

const BaseVoiceAgent = withVoice(Agent);

export class VoiceAgent extends BaseVoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  // Per-connection auth, populated on connect from the ?token= query param.
  private authByConn = new Map<string, { user: AuthUser; token: string }>();

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    try {
      const token = new URL(ctx.request.url).searchParams.get("token");
      const user = await authenticateToken(token, this.env.APP_URL);
      if (user && token) {
        this.authByConn.set(connection.id, { user, token });
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
    const auth = this.authByConn.get(context.connection.id);
    if (!auth) {
      return "I can't access your proposals because you're not signed in. Please sign in on the website and start a new call.";
    }

    const tools = buildProposalTools(this.env.MCP_URL, auth.token);
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

    // Primary: Workers AI. On failure (e.g. neuron quota exceeded, code 4006),
    // fall back to Google Gemini so voice keeps working.
    try {
      const ai = createWorkersAI({ binding: this.env.AI });
      const { text } = await generateText({
        model: ai("@cf/google/gemma-4-26b-a4b-it"),
        ...params,
      });
      return text || fallbackMsg;
    } catch (err: any) {
      console.error("[onTurn] Workers AI failed:", err?.message || err);
      if (!this.env.GEMINI_API_KEY) throw err;
      try {
        const google = createGoogleGenerativeAI({ apiKey: this.env.GEMINI_API_KEY });
        const { text } = await generateText({
          model: google("gemini-flash-latest"),
          ...params,
        });
        console.log("[onTurn] served via Gemini fallback");
        return text || fallbackMsg;
      } catch (err2: any) {
        console.error("[onTurn] Gemini fallback failed:", err2?.message || err2);
        return "Sorry, I'm having trouble reaching the AI service right now. Please try again in a moment.";
      }
    }
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
