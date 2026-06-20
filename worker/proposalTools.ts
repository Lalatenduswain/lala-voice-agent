// Proposal tools for the voice agent — ported from the MCP server, scoped to
// the authenticated user. All reads/writes go through PROPOSALS_DB.

import { tool } from "ai";
import { z } from "zod";
import type { AuthUser } from "./auth";

export function buildProposalTools(
  db: D1Database,
  user: AuthUser,
  token: string,
  appUrl: string,
) {
  return {
    list_proposals: tool({
      description:
        "List the user's proposals, most recent first. Optionally filter by status.",
      inputSchema: z.object({
        status: z
          .enum(["draft", "sent", "viewed", "accepted", "rejected", "expired"])
          .optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ status, limit }) => {
        const lim = Math.min(Math.max(limit ?? 10, 1), 50);
        let sql =
          "SELECT id, proposal_number, title, status, currency, total_amount, created_at FROM proposals WHERE user_id = ?";
        const binds: any[] = [user.id];
        if (status) {
          sql += " AND status = ?";
          binds.push(status);
        }
        sql += " ORDER BY created_at DESC LIMIT ?";
        binds.push(lim);
        const { results } = await db.prepare(sql).bind(...binds).all();
        return { count: results.length, proposals: results };
      },
    }),

    search_proposals: tool({
      description:
        "Search the user's proposals by free text over title, project name, description, and number.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ query, limit }) => {
        const lim = Math.min(Math.max(limit ?? 10, 1), 50);
        const term = `%${query.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
        const { results } = await db
          .prepare(
            `SELECT id, proposal_number, title, status, currency, total_amount, created_at
             FROM proposals
             WHERE user_id = ?
               AND (title LIKE ? ESCAPE '\\' OR project_name LIKE ? ESCAPE '\\'
                 OR description LIKE ? ESCAPE '\\' OR proposal_number LIKE ? ESCAPE '\\')
             ORDER BY created_at DESC LIMIT ?`,
          )
          .bind(user.id, term, term, term, term, lim)
          .all();
        return { count: results.length, proposals: results };
      },
    }),

    get_proposal: tool({
      description:
        "Get full detail for one of the user's proposals, including line items.",
      inputSchema: z.object({ proposalId: z.number().int() }),
      execute: async ({ proposalId }) => {
        const proposal = (await db
          .prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ?")
          .bind(proposalId, user.id)
          .first()) as any;
        if (!proposal) return { error: "Proposal not found" };
        const items = (
          await db
            .prepare(
              "SELECT title, quantity, unit_price, subtotal FROM proposal_items WHERE proposal_id = ? ORDER BY item_order",
            )
            .bind(proposalId)
            .all()
        ).results;
        return { proposal, items };
      },
    }),

    get_proposal_analytics: tool({
      description:
        "Account-wide email engagement funnel (sends/opens/clicks) over the last N days for the user's proposals.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).optional(),
      }),
      execute: async ({ days }) => {
        const d = Math.min(Math.max(days ?? 30, 1), 365);
        const funnel = (await db
          .prepare(
            `SELECT COUNT(*) AS sends,
                    SUM(CASE WHEN el.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
                    SUM(CASE WHEN el.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
             FROM email_logs el JOIN proposals p ON el.proposal_id = p.id
             WHERE p.user_id = ? AND el.created_at >= datetime('now', ?)`,
          )
          .bind(user.id, `-${d} days`)
          .first()) as any;
        const sends = funnel?.sends || 0;
        const pct = (n: number) => (sends ? Math.round((n / sends) * 1000) / 10 : 0);
        return {
          periodDays: d,
          sends,
          opened: funnel?.opened || 0,
          clicked: funnel?.clicked || 0,
          openRate: pct(funnel?.opened || 0),
          clickRate: pct(funnel?.clicked || 0),
        };
      },
    }),

    create_proposal: tool({
      description:
        "Create a new draft proposal owned by the user. Totals are computed from the line items.",
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
      execute: async ({ title, currency, items }) => {
        const norm = items.map((it) => {
          const qty = Number(it.quantity ?? 1);
          const price = Number(it.unitPrice);
          return { ...it, qty, price, subtotal: qty * price };
        });
        const subtotal = norm.reduce((s, it) => s + it.subtotal, 0);
        const proposalNumber = `PROP-${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 6)
          .toUpperCase()}`;
        const res = await db
          .prepare(
            `INSERT INTO proposals
               (proposal_number, user_id, title, project_name, currency,
                subtotal, tax_rate, tax_amount, discount_amount, total_amount, status, ai_generated)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 'draft', 0)`,
          )
          .bind(
            proposalNumber,
            user.id,
            title,
            title,
            currency || "USD",
            subtotal,
            subtotal,
          )
          .run();
        const id = res.meta.last_row_id;
        for (let i = 0; i < norm.length; i++) {
          const it = norm[i];
          await db
            .prepare(
              `INSERT INTO proposal_items (proposal_id, item_order, title, quantity, unit_price, unit_type, subtotal)
               VALUES (?, ?, ?, ?, ?, 'fixed', ?)`,
            )
            .bind(id, i, it.title, it.qty, it.price, it.subtotal)
            .run();
        }
        return { id, proposalNumber, totalAmount: subtotal, itemCount: norm.length };
      },
    }),

    send_proposal: tool({
      description:
        "Email a proposal to a recipient. Confirm the recipient with the user before calling.",
      inputSchema: z.object({
        proposalId: z.number().int(),
        recipientEmail: z.string(),
        recipientName: z.string().optional(),
        message: z.string().optional(),
      }),
      execute: async ({ proposalId, recipientEmail, recipientName, message }) => {
        const resp = await fetch(`${appUrl}/api/proposals/${proposalId}/send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ recipientEmail, recipientName, message }),
        });
        const body: any = await resp.json().catch(() => ({}));
        if (!resp.ok || body.success === false) {
          return { success: false, error: body.error || `Send failed (HTTP ${resp.status})` };
        }
        return { success: true, ...(body.data || {}) };
      },
    }),
  };
}
