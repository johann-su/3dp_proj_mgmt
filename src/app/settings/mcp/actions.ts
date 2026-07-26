"use server";

import { revalidatePath } from "next/cache";
import { getSession, mcpEnabled } from "@/lib/auth";
import { revokeMcpClient } from "@/lib/mcp/clients";

// Cuts off one LLM client's access. Scoped to the caller's own tokens — the
// clientId comes from the browser, so it selects *which* of your connections
// to drop and can never reach another user's.
export async function disconnectMcpClient(
  clientId: string,
): Promise<{ error: string } | void> {
  const session = await getSession();
  if (!session) return { error: "You must be signed in" };
  if (!mcpEnabled) return { error: "The MCP server is disabled" };
  if (!clientId) return { error: "Missing client" };

  await revokeMcpClient(session.user.id, clientId);
  revalidatePath("/settings/mcp");
}
