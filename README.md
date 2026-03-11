# Freshdesk MCP Server

A Model Context Protocol (MCP) server for interacting with the Freshdesk API over HTTP (Streamable HTTP transport). Provides tools to manage tickets, contacts, agents, and more.

## Setup

```bash
npm install
npm run build
npm start
```

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `FRESHDESK_DOMAIN` | Your Freshdesk domain (full hostname) | `yourcompany.freshdesk.com` or `support.yourdomain.com` |
| `PORT` | HTTP port (default `3000`) | `3000` |

## Authentication

The Freshdesk API key is passed via the `Authorization: Bearer <api-key>` header on the MCP connection. It is captured on session initialization and used for all subsequent Freshdesk API calls in that session.

## Docker

```bash
docker build -t freshdesk-mcp .
docker run -d -p 3000:3000 -e FRESHDESK_DOMAIN=yourcompany.freshdesk.com freshdesk-mcp
```

The MCP endpoint is available at `http://your-host:3000/mcp`.

## Claude Configuration

### CLI

```bash
claude mcp add --header "Authorization: Bearer <freshdesk-api-key>" --transport http freshdesk https://your-domain.com/mcp
```

### Manual (settings JSON)

```json
{
  "mcpServers": {
    "freshdesk": {
      "type": "url",
      "url": "https://your-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer <freshdesk-api-key>"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|---|---|
| `list_tickets` | List tickets with pagination and filters |
| `get_ticket` | Get a single ticket by ID (with optional includes) |
| `search_tickets` | Search tickets using Freshdesk query language |
| `get_ticket_conversations` | Get replies and notes for a ticket |
| `add_note_to_ticket` | Add a private or public note to a ticket |
| `reply_to_ticket` | Send a reply to a ticket |
| `create_ticket` | Create a new ticket |
| `update_ticket` | Update ticket properties |
| `delete_ticket` | Delete a ticket |
| `list_contacts` | List contacts (filterable by email/phone) |
| `get_contact` | Get a contact by ID |
| `list_agents` | List support agents |
| `get_agent` | Get an agent by ID |
| `list_groups` | List groups |
| `get_ticket_satisfaction_ratings` | Get satisfaction ratings for a ticket |
| `get_ticket_time_entries` | Get time entries for a ticket |
