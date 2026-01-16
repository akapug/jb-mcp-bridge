# JetBrains MCP Bridge

**stdio→SSE bridge** for JetBrains MCP - enables Gemini CLI, Google Antigravity, Claude Desktop, and other MCP clients to use JetBrains IDE tools.

## The Problem

JetBrains IDEs expose MCP via **SSE** at `localhost:64543/sse`, but many MCP clients (Gemini CLI, Antigravity) expect **stdio** transport. The official `@jetbrains/mcp-proxy` expects a REST API at `:63342/api/mcp/` which returns 404 on most setups.

Additionally, clients like Gemini CLI pass **relative paths** instead of absolute project paths, causing tool failures.

## The Solution

This bridge:
1. Accepts **stdio** transport (JSON-RPC over stdin/stdout)
2. Connects to JetBrains **SSE** at `localhost:64543/sse`
3. Translates paths:
   - **Unix→WSL**: `/home/user/project` → `//wsl.localhost/Ubuntu/home/user/project`
   - **Prepends subfolder**: `src/app` → `projectname/src/app`
4. Auto-reconnects on connection loss
5. Queues requests during startup
6. Traps errors (no crashes)

## Installation

```bash
npm install -g jb-mcp-bridge
# or
npx jb-mcp-bridge
```

## Usage

### Gemini CLI / Antigravity

Add to your `~/.gemini/mcp_config.json`:

```json
{
  "mcpServers": {
    "jetbrains": {
      "command": "npx",
      "args": ["jb-mcp-bridge"],
      "env": {
        "LOG_ENABLED": "true"
      },
      "disabledTools": [
        "permission_prompt",
        "get_file_text_by_path"
      ]
    }
  }
}
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jetbrains": {
      "command": "npx",
      "args": ["jb-mcp-bridge"]
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JB_SSE_URL` | `http://localhost:64543/sse` | JetBrains MCP SSE endpoint |
| `LOG_ENABLED` | `false` | Enable debug logging to stderr |

## Verified Working Tools

- ✅ `get_file_problems` - Error checking
- ✅ `search_in_files_by_text` - Code search
- ✅ `list_directory_tree` - Directory listing
- ✅ `reformat_file` - Code formatting
- ✅ `rename_refactoring` - Symbol renaming (may timeout)
- ✅ `replace_text_in_file` - Find & replace
- ✅ `get_run_configurations` - Run configs
- ✅ `find_files_by_name_keyword` - File search

## Known Issues

- **`get_file_text_by_path`** - May cause issues on some setups, consider disabling
- **`permission_prompt`** - Not useful for headless agents, disable it
- **`rename_refactoring`** - May timeout on large refactors but won't crash

## How It Works

### SSE Protocol Quirk

JetBrains MCP sends `data:` **before** `event:` in SSE responses (opposite of typical SSE). The bridge handles this.

### Path Translation

1. Detects Unix paths (`/home/...`, `/Users/...`)
2. Converts to WSL format: `//wsl.localhost/Ubuntu/...`
3. Extracts project subfolder from path (e.g., `/dev/myproject` → `myproject`)
4. Prepends subfolder to relative paths in tool arguments

## Credits

Built as a workaround for [gemini-cli#14801](https://github.com/google-gemini/gemini-cli/issues/14801)

*— Opus 4.5 in Windsurf JetBrains plugin* 🤖

## License

MIT
