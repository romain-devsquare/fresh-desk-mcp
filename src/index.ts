#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Request, Response as ExpressResponse } from "express";
import express from "express";
import { z } from "zod";

const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;

if (!FRESHDESK_DOMAIN) {
  console.error("FRESHDESK_DOMAIN environment variable is required");
  process.exit(1);
}

const BASE_URL = `https://${FRESHDESK_DOMAIN}/api/v2`;
const PORT = parseInt(process.env.PORT || "3000", 10);
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// OAuth provider – lets Claude authenticate and pass a Freshdesk API key
// ---------------------------------------------------------------------------

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  apiKey?: string;
}

class FreshdeskOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private pendingAuths = new Map<string, PendingAuth>();
  private codes = new Map<string, PendingAuth>();
  private tokens = new Map<
    string,
    { clientId: string; apiKey: string; scopes: string[]; expiresAt: number }
  >();

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => this.clients.get(clientId),
      registerClient: async (
        clientMetadata: OAuthClientInformationFull
      ): Promise<OAuthClientInformationFull> => {
        this.clients.set(clientMetadata.client_id, clientMetadata);
        return clientMetadata;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: ExpressResponse
  ): Promise<void> {
    const pendingId = randomUUID();
    this.pendingAuths.set(pendingId, { client, params });

    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize – Freshdesk MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 16px; }
    h1 { font-size: 1.4rem; }
    label { display: block; margin-top: 12px; font-weight: 600; }
    input[type="password"] { width: 100%; padding: 8px; margin-top: 4px; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 24px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Freshdesk MCP – Authorization</h1>
  <p>Enter your Freshdesk API key to grant access.</p>
  <form method="POST" action="/approve">
    <input type="hidden" name="pending_id" value="${pendingId}">
    <label for="api_key">Freshdesk API Key</label>
    <input type="password" id="api_key" name="api_key" required autocomplete="off">
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`);
  }

  /** Called by the POST /approve handler after the user submits their API key. */
  completeAuthorization(
    pendingId: string,
    apiKey: string
  ): string | null {
    const pending = this.pendingAuths.get(pendingId);
    if (!pending) return null;
    this.pendingAuths.delete(pendingId);

    const code = randomUUID();
    this.codes.set(code, { ...pending, apiKey });

    const redirectUrl = new URL(pending.params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (pending.params.state) {
      redirectUrl.searchParams.set("state", pending.params.state);
    }
    return redirectUrl.toString();
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const data = this.codes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const data = this.codes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    if (data.client.client_id !== client.client_id) {
      throw new Error("Code was not issued to this client");
    }
    if (!data.apiKey) throw new Error("Authorization not completed");

    this.codes.delete(authorizationCode);

    const token = randomUUID();
    console.error(`[oauth] issued token=${token.slice(0, 8)}… for client=${client.client_id.slice(0, 8)}…`);
    const expiresIn = 86400; // 24 h
    this.tokens.set(token, {
      clientId: client.client_id,
      apiKey: data.apiKey,
      scopes: data.params.scopes ?? [],
      expiresAt: Date.now() + expiresIn * 1000,
    });

    return {
      access_token: token,
      token_type: "bearer",
      expires_in: expiresIn,
    };
  }

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new Error("Refresh tokens are not supported");
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const prefix = token.slice(0, 8);
    const stored = [...this.tokens.keys()].map((k) => k.slice(0, 8));
    console.error(`[oauth] verifyAccessToken token=${prefix}… stored=[${stored}] (${this.tokens.size})`);
    const data = this.tokens.get(token);
    if (!data) {
      console.error("[oauth] token not found in store");
      throw new Error("Invalid or expired token");
    }
    if (data.expiresAt < Date.now()) {
      console.error("[oauth] token expired");
      throw new Error("Invalid or expired token");
    }
    console.error("[oauth] token verified OK");
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
      extra: { freshdeskApiKey: data.apiKey },
    };
  }
}

async function freshdeskRequest(
  apiKey: string,
  path: string,
  method: string = "GET",
  body?: unknown
): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  console.error(`[freshdesk] ${method} ${url}`);

  const headers: Record<string, string> = {
    Authorization:
      "Basic " + Buffer.from(apiKey + ":X").toString("base64"),
    "Content-Type": "application/json",
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause
        ? ` | cause: ${JSON.stringify(err.cause, Object.getOwnPropertyNames(err.cause as object))}`
        : "";
    throw new Error(`Network error fetching ${url}: ${msg}${cause}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Freshdesk API error ${res.status}: ${text}`);
  }

  if (res.status === 204) return { success: true };
  return res.json();
}

function createServer(apiKey: string): McpServer {
  const server = new McpServer({
    name: "freshdesk",
    version: "1.0.0",
  });

  // --- List tickets ---
  server.tool(
    "list_tickets",
    "List tickets from Freshdesk. Returns paginated results (30 per page).",
    {
      page: z.number().optional().describe("Page number (default 1)"),
      per_page: z
        .number()
        .optional()
        .describe("Results per page, max 100 (default 30)"),
      filter: z
        .enum(["new_and_my_open", "watching", "spam", "deleted"])
        .optional()
        .describe("Predefined filter"),
      order_by: z
        .enum(["created_at", "due_by", "updated_at", "status"])
        .optional()
        .describe("Field to order by (default created_at)"),
      order_type: z
        .enum(["asc", "desc"])
        .optional()
        .describe("Order direction (default desc)"),
    },
    async (params) => {
      const query = new URLSearchParams();
      if (params.page) query.set("page", String(params.page));
      if (params.per_page) query.set("per_page", String(params.per_page));
      if (params.filter) query.set("filter", params.filter);
      if (params.order_by) query.set("order_by", params.order_by);
      if (params.order_type) query.set("order_type", params.order_type);

      const qs = query.toString();
      const tickets = await freshdeskRequest(
        apiKey,
        `/tickets${qs ? "?" + qs : ""}`
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(tickets, null, 2) },
        ],
      };
    }
  );

  // --- Get ticket details ---
  server.tool(
    "get_ticket",
    "Get a single ticket by ID, including conversation details.",
    {
      ticket_id: z.number().describe("The ticket ID"),
      include: z
        .enum(["conversations", "requester", "company", "stats"])
        .optional()
        .describe("Include additional data"),
    },
    async (params) => {
      const query = params.include ? `?include=${params.include}` : "";
      const ticket = await freshdeskRequest(
        apiKey,
        `/tickets/${params.ticket_id}${query}`
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(ticket, null, 2) },
        ],
      };
    }
  );

  // --- Search tickets ---
  server.tool(
    "search_tickets",
    'Search tickets using Freshdesk query language. Example query: "status:2 AND priority:3"',
    {
      query: z
        .string()
        .describe(
          'Freshdesk search query. e.g. "status:2", "priority:1 AND created_at:>\'2024-01-01\'"'
        ),
      page: z.number().optional().describe("Page number (default 1)"),
    },
    async (params) => {
      const query = new URLSearchParams();
      query.set("query", `"${params.query}"`);
      if (params.page) query.set("page", String(params.page));

      const results = await freshdeskRequest(
        apiKey,
        `/search/tickets?${query.toString()}`
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(results, null, 2) },
        ],
      };
    }
  );

  // --- Get ticket conversations (comments/replies) ---
  server.tool(
    "get_ticket_conversations",
    "Get all conversations (replies and notes) for a ticket.",
    {
      ticket_id: z.number().describe("The ticket ID"),
      page: z.number().optional().describe("Page number (default 1)"),
    },
    async (params) => {
      const query = params.page ? `?page=${params.page}` : "";
      const conversations = await freshdeskRequest(
        apiKey,
        `/tickets/${params.ticket_id}/conversations${query}`
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(conversations, null, 2),
          },
        ],
      };
    }
  );

  // --- Add a note to a ticket ---
  server.tool(
    "add_note_to_ticket",
    "Add a private or public note to a ticket.",
    {
      ticket_id: z.number().describe("The ticket ID"),
      body: z.string().describe("The note content (HTML supported)"),
      private: z
        .boolean()
        .optional()
        .describe("Whether the note is private (default true)"),
    },
    async (params) => {
      const note = await freshdeskRequest(
        apiKey,
        `/tickets/${params.ticket_id}/notes`,
        "POST",
        {
          body: params.body,
          private: params.private ?? true,
        }
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(note, null, 2) },
        ],
      };
    }
  );

  // --- Reply to a ticket ---
  server.tool(
    "reply_to_ticket",
    "Send a reply to a ticket.",
    {
      ticket_id: z.number().describe("The ticket ID"),
      body: z.string().describe("The reply content (HTML supported)"),
    },
    async (params) => {
      const reply = await freshdeskRequest(
        apiKey,
        `/tickets/${params.ticket_id}/reply`,
        "POST",
        { body: params.body }
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(reply, null, 2) },
        ],
      };
    }
  );

  // --- Create a ticket ---
  server.tool(
    "create_ticket",
    "Create a new Freshdesk ticket.",
    {
      subject: z.string().describe("Ticket subject"),
      description: z.string().describe("Ticket description (HTML supported)"),
      email: z.string().optional().describe("Requester email"),
      priority: z
        .number()
        .optional()
        .describe("Priority: 1=Low, 2=Medium, 3=High, 4=Urgent"),
      status: z
        .number()
        .optional()
        .describe("Status: 2=Open, 3=Pending, 4=Resolved, 5=Closed"),
      type: z.string().optional().describe("Ticket type"),
      tags: z.array(z.string()).optional().describe("Tags for the ticket"),
    },
    async (params) => {
      const ticket = await freshdeskRequest(apiKey, "/tickets", "POST", {
        subject: params.subject,
        description: params.description,
        email: params.email,
        priority: params.priority ?? 1,
        status: params.status ?? 2,
        type: params.type,
        tags: params.tags,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(ticket, null, 2) },
        ],
      };
    }
  );

  // --- Update a ticket ---
  server.tool(
    "update_ticket",
    "Update an existing ticket's properties.",
    {
      ticket_id: z.number().describe("The ticket ID"),
      subject: z.string().optional().describe("New subject"),
      description: z.string().optional().describe("New description"),
      priority: z
        .number()
        .optional()
        .describe("Priority: 1=Low, 2=Medium, 3=High, 4=Urgent"),
      status: z
        .number()
        .optional()
        .describe("Status: 2=Open, 3=Pending, 4=Resolved, 5=Closed"),
      type: z.string().optional().describe("Ticket type"),
      tags: z.array(z.string()).optional().describe("Tags"),
    },
    async (params) => {
      const { ticket_id, ...body } = params;
      const ticket = await freshdeskRequest(
        apiKey,
        `/tickets/${ticket_id}`,
        "PUT",
        body
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(ticket, null, 2) },
        ],
      };
    }
  );

  // --- Delete a ticket ---
  server.tool(
    "delete_ticket",
    "Delete a ticket by ID.",
    {
      ticket_id: z.number().describe("The ticket ID to delete"),
    },
    async (params) => {
      await freshdeskRequest(
        apiKey,
        `/tickets/${params.ticket_id}`,
        "DELETE"
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Ticket ${params.ticket_id} deleted.`,
          },
        ],
      };
    }
  );

  // --- List contacts ---
  server.tool(
    "list_contacts",
    "List contacts from Freshdesk.",
    {
      page: z.number().optional().describe("Page number"),
      email: z.string().optional().describe("Filter by email"),
      phone: z.string().optional().describe("Filter by phone"),
    },
    async (params) => {
      const query = new URLSearchParams();
      if (params.page) query.set("page", String(params.page));
      if (params.email) query.set("email", params.email);
      if (params.phone) query.set("phone", params.phone);

      const qs = query.toString();
      const contacts = await freshdeskRequest(
        apiKey,
        `/contacts${qs ? "?" + qs : ""}`
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(contacts, null, 2) },
        ],
      };
    }
  );

  // --- Get contact ---
  server.tool(
    "get_contact",
    "Get a single contact by ID.",
    {
      contact_id: z.number().describe("The contact ID"),
    },
    async (params) => {
      const contact = await freshdeskRequest(
        apiKey,
        `/contacts/${params.contact_id}`
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(contact, null, 2) },
        ],
      };
    }
  );

  // --- List agents ---
  server.tool(
    "list_agents",
    "List agents (support staff) from Freshdesk.",
    {
      page: z.number().optional().describe("Page number"),
    },
    async (params) => {
      const query = params.page ? `?page=${params.page}` : "";
      const agents = await freshdeskRequest(apiKey, `/agents${query}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(agents, null, 2) },
        ],
      };
    }
  );

  // --- Get agent ---
  server.tool(
    "get_agent",
    "Get a single agent by ID.",
    {
      agent_id: z.number().describe("The agent ID"),
    },
    async (params) => {
      const agent = await freshdeskRequest(
        apiKey,
        `/agents/${params.agent_id}`
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(agent, null, 2) },
        ],
      };
    }
  );

  // --- List groups ---
  server.tool(
    "list_groups",
    "List groups from Freshdesk.",
    {},
    async () => {
      const groups = await freshdeskRequest(apiKey, "/groups");
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(groups, null, 2) },
        ],
      };
    }
  );

  // --- Get ticket satisfaction ratings ---
  server.tool(
    "get_ticket_satisfaction_ratings",
    "Get satisfaction ratings for a ticket.",
    {
      ticket_id: z.number().describe("The ticket ID"),
    },
    async (params) => {
      const ratings = await freshdeskRequest(
        apiKey,
        `/tickets/${params.ticket_id}/satisfaction_ratings`
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(ratings, null, 2) },
        ],
      };
    }
  );

  // --- Get ticket time entries ---
  server.tool(
    "get_ticket_time_entries",
    "Get time entries logged against a ticket.",
    {
      ticket_id: z.number().describe("The ticket ID"),
    },
    async (params) => {
      const entries = await freshdeskRequest(
        apiKey,
        `/tickets/${params.ticket_id}/time_entries`
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(entries, null, 2) },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport with OAuth
// ---------------------------------------------------------------------------

const serverUrl = new URL(SERVER_URL);
const mcpUrl = new URL("/mcp", serverUrl);

const oauthProvider = new FreshdeskOAuthProvider();

const app = createMcpExpressApp({ host: "0.0.0.0" });

// Trust the first reverse-proxy hop (traefik, nginx, etc.) so that
// express-rate-limit inside mcpAuthRouter reads the real client IP
// from X-Forwarded-For instead of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set("trust proxy", 1);

// OAuth endpoints (/authorize, /token, /register, /.well-known/*)
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: serverUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: [],
  })
);

// Form submission endpoint for the authorization page
app.post("/approve", express.urlencoded({ extended: false }), (req, res) => {
  const { pending_id, api_key } = req.body as {
    pending_id?: string;
    api_key?: string;
  };
  if (!pending_id || !api_key) {
    res.status(400).send("Missing required fields");
    return;
  }
  const redirectUri = oauthProvider.completeAuthorization(pending_id, api_key);
  if (!redirectUri) {
    res.status(400).send("Invalid or expired authorization request");
    return;
  }
  res.redirect(redirectUri);
});

// Bearer-auth middleware for MCP routes
const rawBearerAuth = requireBearerAuth({
  verifier: oauthProvider,
  requiredScopes: [],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});

// Wrap to log auth failures that the SDK middleware silently swallows
const bearerAuth: typeof rawBearerAuth = (req, res, next) => {
  const hasAuth = !!req.headers.authorization;
  console.error(`[mcp] ${req.method} ${req.path} auth-header=${hasAuth} session=${req.headers["mcp-session-id"] ?? "none"}`);
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 400) {
      console.error(`[mcp] bearer auth rejected: ${res.statusCode}`, body);
    }
    return originalJson(body);
  }) as typeof res.json;
  rawBearerAuth(req, res, next);
};

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", bearerAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const apiKey = req.auth?.extra?.freshdeskApiKey as string | undefined;
      if (!apiKey) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Unauthorized: no API key in token" },
          id: null,
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };

      const server = createServer(apiKey);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", bearerAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", bearerAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Freshdesk MCP server listening on http://0.0.0.0:${PORT}/mcp`);
  console.log(`OAuth issuer: ${serverUrl.href}`);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  for (const sid in transports) {
    await transports[sid].close();
    delete transports[sid];
  }
  process.exit(0);
});
