#!/usr/bin/env tsx
/**
 * JetBrains MCP stdio→SSE Bridge (V2.1)
 * 
 * Bridges stdio transport (Gemini CLI, Antigravity, Claude Desktop) to
 * JetBrains MCP SSE transport (what actually works on the IDE).
 * 
 * Features:
 * - Auto-reconnection with request queueing
 * - Unix→WSL path translation  
 * - Project subfolder prepending
 * - Global error trapping
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const JB_SSE_URL = process.env.JB_SSE_URL || 'http://localhost:64543/sse';
const JB_BASE_URL = new URL(JB_SSE_URL).origin;
const LOG_FILE = path.join(os.tmpdir(), 'jb-bridge.log');

function log(msg: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${msg} ${data ? JSON.stringify(data) : ''}\n`;
  try { fs.appendFileSync(LOG_FILE, logLine); } catch {}
  console.error(`[bridge] ${msg}`, data || '');
}

interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// Path translation
function unixToWslPath(unixPath: string): string {
  let normalized = unixPath.replace(/\/@[^/]+\//, '/');
  return `//wsl.localhost/Ubuntu${normalized}`;
}

function extractProjectSubfolder(projectPath: string): string | null {
  const normalized = projectPath.replace(/\/@[^/]+\//, '/');
  const match = normalized.match(/\/dev\/([^/]+)$/);
  return match ? match[1] : null;
}

function classifyPath(p: string): 'wsl' | 'unix' | 'windows' | 'relative' {
  if (!p) return 'relative';
  if (p.startsWith('//wsl.localhost') || p.startsWith('\\\\wsl.localhost')) return 'wsl';
  if (p.startsWith('/home/') || p.startsWith('/Users/') || p.startsWith('/tmp/')) return 'unix';
  if (/^[A-Za-z]:/.test(p)) return 'windows';
  return 'relative';
}

function transformRequest(request: MCPRequest): MCPRequest {
  if (request.method !== 'tools/call' || !request.params?.arguments) return request;
  
  const args = { ...(request.params.arguments as Record<string, unknown>) };
  let projectSubfolder: string | null = null;
  
  if (args.projectPath && typeof args.projectPath === 'string' && classifyPath(args.projectPath) === 'unix') {
    projectSubfolder = extractProjectSubfolder(args.projectPath);
    const wslPath = unixToWslPath(args.projectPath);
    log(`path UNIX→WSL: ${args.projectPath} → ${wslPath}`);
    args.projectPath = wslPath;
  }
  
  if (projectSubfolder) {
    const relativePathKeys = ['directoryPath', 'filePath', 'pathInProject', 'path', 'subDirectoryRelativePath', 'directoryToSearch', 'file_path'];
    for (const key of relativePathKeys) {
      if (args[key] && typeof args[key] === 'string') {
        const val = args[key] as string;
        if (!val.startsWith('/') && !val.startsWith(projectSubfolder)) {
          log(`path PREPEND: ${val} → ${projectSubfolder}/${val}`);
          args[key] = `${projectSubfolder}/${val}`;
        }
      }
    }
  }
  
  return { ...request, params: { ...request.params, arguments: args } };
}

class JBStdioSSEBridge {
  private jbMessageEndpoint: string | null = null;
  private pendingRequests = new Map<string | number, { resolve: (r: MCPResponse) => void; reject: (e: Error) => void }>();
  private isConnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor() { this.startConnectionLoop(); }

  private startConnectionLoop() {
    this.connect().catch(err => {
      log('Initial connection failed, retrying...', err);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      log('Attempting reconnection...');
      this.connect().catch(err => { log('Reconnection failed', err); this.scheduleReconnect(); });
    }, 2000);
  }
  
  async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;
    log(`Connecting to JetBrains MCP SSE: ${JB_SSE_URL}`);
    
    try {
      const response = await fetch(JB_SSE_URL, { headers: { 'Accept': 'text/event-stream' } });
      if (!response.ok || !response.body) throw new Error(`Failed to connect: ${response.status}`);
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      log('SSE Connected');
      this.isConnecting = false;
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) { log('SSE stream ended'); this.jbMessageEndpoint = null; this.scheduleReconnect(); break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        this.processLines(lines);
      }
    } catch (error) {
      log('Connection error:', error);
      this.jbMessageEndpoint = null;
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private processLines(lines: string[]) {
    let pendingData = '', pendingEvent = '';
    for (const line of lines) {
      if (line.startsWith('data: ')) pendingData = line.slice(6);
      else if (line.startsWith('event: ')) {
        pendingEvent = line.slice(7).trim();
        if (pendingData && pendingEvent) {
          if (pendingEvent === 'endpoint') { this.jbMessageEndpoint = pendingData; log(`Got endpoint: ${this.jbMessageEndpoint}`); }
          else if (pendingEvent === 'message') {
            try { this.handleResponse(JSON.parse(pendingData) as MCPResponse); } catch {}
          }
          pendingData = pendingEvent = '';
        }
      }
    }
  }
  
  private handleResponse(response: MCPResponse) {
    if (response.id !== undefined) {
      const pending = this.pendingRequests.get(response.id);
      if (pending) { pending.resolve(response); this.pendingRequests.delete(response.id); }
    }
  }

  private waitForConnection(timeoutMs = 20000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.jbMessageEndpoint) return resolve();
      const start = Date.now();
      const check = setInterval(() => {
        if (this.jbMessageEndpoint) { clearInterval(check); resolve(); }
        else if (Date.now() - start > timeoutMs) { clearInterval(check); reject(new Error('Connection timeout')); }
      }, 100);
    });
  }
  
  async sendRequest(request: MCPRequest): Promise<MCPResponse> {
    if (!this.jbMessageEndpoint) {
      log('Queuing request...');
      await this.waitForConnection();
    }
    
    const transformed = transformRequest(request);
    const requestId = transformed.id ?? Math.random().toString(36).slice(2);
    const fullRequest = { ...transformed, id: requestId };
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingRequests.delete(requestId); reject(new Error('Request timeout (30s)')); }, 30000);
      this.pendingRequests.set(requestId, {
        resolve: (r) => { clearTimeout(timeout); resolve(r); },
        reject: (e) => { clearTimeout(timeout); reject(e); }
      });
      
      fetch(`${JB_BASE_URL}${this.jbMessageEndpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullRequest)
      }).catch(error => { this.pendingRequests.delete(requestId); clearTimeout(timeout); reject(error); });
    });
  }
}

// Global error handlers
process.on('uncaughtException', (err) => log('UNCAUGHT EXCEPTION', err));
process.on('unhandledRejection', (reason) => log('UNHANDLED REJECTION', reason));

async function main() {
  log('Bridge V2.1 Starting...');
  const bridge = new JBStdioSSEBridge();
  
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  
  rl.on('line', async (line) => {
    try {
      const request = JSON.parse(line) as MCPRequest;
      try {
        const response = await bridge.sendRequest(request);
        process.stdout.write(JSON.stringify(response) + '\n');
      } catch (reqError) {
        log(`Request failed: ${request.method}`, reqError);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(reqError) } }) + '\n');
      }
    } catch { log('Invalid JSON on stdin', line); }
  });
  
  rl.on('close', () => { log('stdin closed'); process.exit(0); });
}

main().catch(err => log('Main error', err));
