# goclaw-agent

Standalone agent container powered by the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents/claude-agent-sdk). Deploy autonomous AI agents on any cloud with a single Docker image.

## Quick Start

```bash
# Build the image
docker build -t goclaw-agent .

# Run with your Anthropic API key
docker run -d \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e GOCLAW_AGENT_NAME=my-agent \
  -p 3000:3000 \
  goclaw-agent

# Send a message to the agent
curl -X POST http://localhost:3000/api/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "Hello! What can you do?", "sender": "user"}'

# Set the agent's identity
curl -X POST http://localhost:3000/api/personality \
  -H 'Content-Type: application/json' \
  -d '{"claudeMd": "# My Agent\n\nYou are a helpful customer support agent for Acme Corp..."}'
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  goclaw-agent container                     │
│                                             │
│  entrypoint.sh                              │
│    ├── workspace-sync.sh (S3 hydrate)       │
│    ├── workspace-sync.sh watch (periodic)   │
│    └── server.js (HTTP)                     │
│          └── agent-runner (Claude SDK)      │
│                ├── IPC MCP server           │
│                └── ACB hook (optional)      │
│                                             │
│  /workspace/group/                          │
│    ├── CLAUDE.md        (agent identity)    │
│    ├── knowledge/       (persistent KB)     │
│    ├── skills/          (learned skills)    │
│    ├── conversations/   (archived chats)    │
│    ├── memory/          (auto-memory)       │
│    └── .claude/         (SDK settings)      │
└─────────────────────────────────────────────┘
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (returns `{status, agent, uptime}`) |
| POST | `/api/message` | Send a message to the agent (`{text, sender?, channel?}`) |
| POST | `/api/personality` | Write the agent's CLAUDE.md (`{claudeMd}`) |
| POST | `/api/knowledge` | Write knowledge entries (`{entries: [{category?, slug, content}]}`) |

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GOCLAW_AGENT_NAME` | `goclaw-agent` | Agent name (used for S3 prefix, health endpoint) |
| `GOCLAW_AGENT_PORT` | `3000` | HTTP server port |
| `GOCLAW_S3_BUCKET` | *(none)* | S3 bucket for workspace persistence |
| `GOCLAW_SYNC_PUSH` | `60` | S3 push interval in seconds |
| `GOCLAW_SERVER_CMD` | `node /app/goclaw-agent/dist/server.js` | Override to use a custom server |
| `ACB_ENABLED` | `1` | Set to `0` to disable the Agent Circuit Breaker |

## S3 Persistence

When `GOCLAW_S3_BUCKET` and `GOCLAW_AGENT_NAME` are set, the container automatically:

1. **Hydrates** workspace from S3 on boot
2. **Pushes** workspace changes to S3 every 60s (configurable)
3. **Snapshots** workspace to S3 on graceful shutdown (SIGTERM)

Synced paths: `CLAUDE.md`, `knowledge/`, `skills/`, `conversations/`, `data/`, `public/`, `tools/`, `memory/`, `.claude/`

## Extending

goclaw-agent is designed to be extended. Use it as a base image and add your own MCP servers, tools, or HTTP endpoints.

```dockerfile
FROM goclaw-agent:latest

# Add your MCP server
COPY my-mcp-server.js /app/my-mcp-server.js

# Override the server command to use your custom server
ENV GOCLAW_SERVER_CMD="node /app/my-custom-server.js"
```

The agent-runner automatically connects MCP servers specified via the `GOCLAW_MCP_SERVER_PATH` environment variable:

```dockerfile
ENV GOCLAW_MCP_SERVER_PATH=/app/my-mcp-server.js
```

## AWS Deployment (ECS Fargate)

Infrastructure templates are included in `infra/`:

| File | Description |
|------|-------------|
| `task-def-template.json` | ECS Fargate task definition (always-on) |
| `task-def-serverless.json` | ECS Fargate task definition (serverless / on-demand) |
| `iam-policy.json` | Minimal IAM policy for agent containers |
| `security-group.yaml` | Security group configuration |

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run locally (requires ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-ant-... npm start
```

## License

MIT
