#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN; // e.g. "support.yourcompany.com" or "yourcompany.freshdesk.com"
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

if (!FRESHDESK_DOMAIN || !FRESHDESK_API_KEY) {
  console.error(
    "FRESHDESK_DOMAIN and FRESHDESK_API_KEY environment variables are required"
  );
  process.exit(1);
}

const BASE_URL = `https://${FRESHDESK_DOMAIN}/api/v2`;

async function freshdeskRequest(
  path: string,
  method: string = "GET",
  body?: unknown
): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  console.error(`[freshdesk] ${method} ${url}`);

  const headers: Record<string, string> = {
    Authorization:
      "Basic " + Buffer.from(FRESHDESK_API_KEY + ":X").toString("base64"),
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
      .enum([
        "new_and_my_open",
        "watching",
        "spam",
        "deleted",
      ])
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
    const tickets = await freshdeskRequest(`/tickets${qs ? "?" + qs : ""}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(tickets, null, 2) }] };
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
    const ticket = await freshdeskRequest(`/tickets/${params.ticket_id}${query}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(ticket, null, 2) }] };
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

    const results = await freshdeskRequest(`/search/tickets?${query.toString()}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
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
      `/tickets/${params.ticket_id}/conversations${query}`
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(conversations, null, 2) }] };
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
      `/tickets/${params.ticket_id}/notes`,
      "POST",
      {
        body: params.body,
        private: params.private ?? true,
      }
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(note, null, 2) }] };
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
      `/tickets/${params.ticket_id}/reply`,
      "POST",
      { body: params.body }
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(reply, null, 2) }] };
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
    const ticket = await freshdeskRequest("/tickets", "POST", {
      subject: params.subject,
      description: params.description,
      email: params.email,
      priority: params.priority ?? 1,
      status: params.status ?? 2,
      type: params.type,
      tags: params.tags,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(ticket, null, 2) }] };
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
    priority: z.number().optional().describe("Priority: 1=Low, 2=Medium, 3=High, 4=Urgent"),
    status: z.number().optional().describe("Status: 2=Open, 3=Pending, 4=Resolved, 5=Closed"),
    type: z.string().optional().describe("Ticket type"),
    tags: z.array(z.string()).optional().describe("Tags"),
  },
  async (params) => {
    const { ticket_id, ...body } = params;
    const ticket = await freshdeskRequest(`/tickets/${ticket_id}`, "PUT", body);
    return { content: [{ type: "text" as const, text: JSON.stringify(ticket, null, 2) }] };
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
    await freshdeskRequest(`/tickets/${params.ticket_id}`, "DELETE");
    return { content: [{ type: "text" as const, text: `Ticket ${params.ticket_id} deleted.` }] };
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
    const contacts = await freshdeskRequest(`/contacts${qs ? "?" + qs : ""}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(contacts, null, 2) }] };
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
    const contact = await freshdeskRequest(`/contacts/${params.contact_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(contact, null, 2) }] };
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
    const agents = await freshdeskRequest(`/agents${query}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(agents, null, 2) }] };
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
    const agent = await freshdeskRequest(`/agents/${params.agent_id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(agent, null, 2) }] };
  }
);

// --- List groups ---
server.tool(
  "list_groups",
  "List groups from Freshdesk.",
  {},
  async () => {
    const groups = await freshdeskRequest("/groups");
    return { content: [{ type: "text" as const, text: JSON.stringify(groups, null, 2) }] };
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
      `/tickets/${params.ticket_id}/satisfaction_ratings`
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(ratings, null, 2) }] };
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
      `/tickets/${params.ticket_id}/time_entries`
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Freshdesk MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
