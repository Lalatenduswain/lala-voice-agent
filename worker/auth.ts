// Token verification by DELEGATION to the ProposalForge app.
//
// Rather than sharing the app's JWT_SECRET, the voice agent verifies a bearer
// token by calling the app's /api/auth/me endpoint (which checks the signature
// AND the live session, then returns the user). This keeps a single source of
// truth for auth and avoids distributing the secret to another service.

export interface AuthUser {
  id: number;
  email: string;
  fullName: string | null;
  companyName: string | null;
}

/**
 * Resolve a bearer token to a user via the app's /api/auth/me endpoint.
 * Returns null for any missing/invalid/expired token.
 */
export async function authenticateToken(
  token: string | null | undefined,
  appUrl: string,
): Promise<AuthUser | null> {
  if (!token) return null;
  try {
    const resp = await fetch(`${appUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const body: any = await resp.json();
    if (!body?.success || !body.data) return null;
    const d = body.data;
    return {
      id: d.id,
      email: d.email,
      fullName: d.fullName ?? null,
      companyName: d.companyName ?? null,
    };
  } catch (err) {
    console.error("[authenticateToken] error", err);
    return null;
  }
}
