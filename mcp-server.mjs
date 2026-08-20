/**
 * AI Admin Dashboard — MCP server for Claude Desktop
 *
 * Exposes the dashboard's data to Claude as tools. Claude Desktop launches
 * this file; it talks to the running dashboard over HTTP (localhost:3001),
 * so the dashboard must be running (open it with "Iniciar AI Admin Dashboard.bat").
 *
 * Tool definitions live in mcp-tools.cjs, shared with server.js's /mcp
 * StreamableHTTP endpoint (used for the cloud instance) — this file only
 * wires up the stdio transport and the loopback HTTP helpers.
 *
 * Configure Claude Desktop by adding this to claude_desktop_config.json:
 *   "mcpServers": {
 *     "ai-admin-dashboard": { "command": "node", "args": ["<full path>/mcp-server.mjs"] }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './mcp-tools.cjs';

const BASE = process.env.DASHBOARD_URL || 'http://localhost:3001';

async function getJSON(pathname, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${pathname}`, { signal: ac.signal });
    if (!res.ok) return { _error: `El dashboard respondió ${res.status} en ${pathname}` };
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') return { _error: `El dashboard tardó demasiado en responder (${timeoutMs / 1000}s). ¿Está sobrecargado o cerrado?` };
    return { _error: `No se pudo conectar al dashboard en ${BASE}. ¿Está abierto? Ábrelo con "Iniciar AI Admin Dashboard.bat".` };
  } finally {
    clearTimeout(timer);
  }
}

const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

async function doFetch(url, options = {}, timeoutMs = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request to ${url} timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const server = new McpServer({ name: 'ai-admin-dashboard', version: '1.0.0' });
registerAllTools(server, { BASE, getJSON, doFetch, text });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('AI Admin Dashboard MCP server listo (stdio).');
