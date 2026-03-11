# Freshdesk MCP Server

A Model Context Protocol (MCP) server for interacting with the Freshdesk API. Provides tools to manage tickets, contacts, agents, and more.

## Setup

```bash
npm install
npm run build
```

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `FRESHDESK_DOMAIN` | Your Freshdesk domain (full hostname) | `yourcompany.freshdesk.com` or `support.yourdomain.com` |
| `FRESHDESK_API_KEY` | Your Freshdesk API key | Found in Profile Settings > API Key |

## Claude Code Configuration

Add this to your Claude Code MCP settings (`claude_desktop_config.json` or `.claude/settings.json`):

```json
{
  "mcpServers": {
    "freshdesk": {
      "command": "node",
      "args": [
        "C:/Repositories/fresh-desk-mcp/build/index.js"
      ],
      "env": {
        "FRESHDESK_DOMAIN": "yourcompany.freshdesk.com",
        "FRESHDESK_API_KEY": "your-api-key-here"
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
