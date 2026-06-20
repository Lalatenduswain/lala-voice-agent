// Proposal tools for the voice agent — these call the ProposalForge MCP server
// over HTTP (JSON-RPC), forwarding the signed-in user's token. This keeps the
// voice agent free of any direct database binding, so it can be deployed in a
// different Cloudflare account (e.g. for separate Workers AI quota) while the
// data stays in the app's account.

import { tool } from "ai";
import { z } from "zod";

/** Call a tool on the MCP server and return its parsed JSON result. */
async function callMcp(
  mcpUrl: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  try {
    const resp = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body: any = await resp.json().catch(() => ({}));
    if (body?.error) return { error: body.error.message || "MCP error" };
    const text = body?.result?.content?.[0]?.text;
    if (body?.result?.isError) return { error: text || "tool error" };
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  } catch (err: any) {
    return { error: `Could not reach the proposal service: ${err?.message}` };
  }
}

export function buildProposalTools(mcpUrl: string, token: string) {
  const call = (name: string, args: Record<string, unknown>) =>
    callMcp(mcpUrl, token, name, args);

  return {
    list_proposals: tool({
      description: "List the user's proposals, most recent first. Optionally filter by status.",
      inputSchema: z.object({
        status: z
          .enum(["draft", "sent", "viewed", "accepted", "rejected", "expired"])
          .optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (args) => call("list_proposals", args),
    }),

    search_proposals: tool({
      description: "Search the user's proposals by free text.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (args) => call("search_proposals", args),
    }),

    get_proposal: tool({
      description: "Get full detail for one of the user's proposals.",
      inputSchema: z.object({ proposalId: z.number().int() }),
      execute: async (args) => call("get_proposal", args),
    }),

    get_proposal_analytics: tool({
      description:
        "Email engagement analytics. Without proposalId, an account-wide funnel over the last N days.",
      inputSchema: z.object({
        proposalId: z.number().int().optional(),
        days: z.number().int().min(1).max(365).optional(),
      }),
      execute: async (args) => call("get_proposal_analytics", args),
    }),

    create_proposal: tool({
      description:
        "Create a new draft proposal. Confirm the title and at least one line item before calling.",
      inputSchema: z.object({
        title: z.string(),
        currency: z.string().optional(),
        items: z
          .array(
            z.object({
              title: z.string(),
              quantity: z.number().optional(),
              unitPrice: z.number(),
            }),
          )
          .min(1),
      }),
      execute: async (args) => call("create_proposal", args),
    }),

    send_proposal: tool({
      description:
        "Email a proposal to a recipient. ALWAYS confirm the recipient and which proposal first.",
      inputSchema: z.object({
        proposalId: z.number().int(),
        recipientEmail: z.string(),
        recipientName: z.string().optional(),
        message: z.string().optional(),
      }),
      execute: async (args) => call("send_proposal", args),
    }),
  };
}
