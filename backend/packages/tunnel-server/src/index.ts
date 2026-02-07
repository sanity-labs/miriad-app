/**
 * Tunnel Server - Auth wrapper + routing proxy for rathole
 *
 * This service provides:
 * 1. Health check endpoint for ALB
 * 2. Client registration (containers authenticate and get assigned a port)
 * 3. Host-based routing proxy (routes {hash}.domain to correct rathole port)
 *
 * Architecture:
 * - ALB terminates TLS, forwards to Hono on :8080
 * - Container registers via /clients/register with CAST_AUTH_TOKEN
 * - Hono writes service entry to rathole config (hot-reload picks it up)
 * - User traffic: Hono extracts hash from Host header, proxies to rathole port
 * - rathole tunnels traffic to container
 */

import { Hono } from 'hono';
import { verifyContainerToken, extractContainerToken } from './auth.js';
import {
  initializeConfig,
  registerService,
  unregisterService,
  getService,
  getServiceOwner,
  listServices,
  buildServiceId,
} from './config.js';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const app = new Hono();

// Initialize rathole config on startup
initializeConfig();

// =============================================================================
// Health Check
// =============================================================================

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'cast-tunnel-server',
    clients: listServices().length,
  });
});

// =============================================================================
// Client Registration API
// =============================================================================

/**
 * POST /clients/register
 *
 * Container calls this to register for tunnel access.
 * Requires CAST_AUTH_TOKEN in Authorization header.
 *
 * Request: { tunnelHash: "...", serviceName?: "..." }
 * Response: {
 *   success: true,
 *   serviceToken: "...",  // Token for rathole connection
 *   controlPort: 2333,    // Rathole control port to connect to
 *   serviceName: "..."    // Service ID to use in client config ({serviceName}-{hash} or {hash})
 * }
 */
app.post('/clients/register', async (c) => {
  // Validate container token
  const authHeader = c.req.header('Authorization');
  const token = extractContainerToken(authHeader);

  if (!token) {
    return c.json({ success: false, error: 'No auth token provided' }, 401);
  }

  const payload = verifyContainerToken(token);
  if (!payload) {
    return c.json({ success: false, error: 'Invalid auth token' }, 401);
  }

  // Get tunnel hash and optional service name from request body
  let tunnelHash: string;
  let serviceName: string | undefined;
  try {
    const body = await c.req.json();
    tunnelHash = body.tunnelHash;
    serviceName = body.serviceName;
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }

  if (!tunnelHash || typeof tunnelHash !== 'string' || tunnelHash.length < 32) {
    return c.json({ success: false, error: 'Invalid tunnelHash' }, 400);
  }

  // Validate serviceName if provided
  if (serviceName !== undefined && typeof serviceName !== 'string') {
    return c.json({ success: false, error: 'Invalid serviceName' }, 400);
  }

  // Generate a unique token for this service (rathole uses this to authenticate)
  const serviceToken = randomBytes(32).toString('hex');

  // Register service in rathole config with owner info for auth verification
  const result = registerService(
    tunnelHash,
    serviceToken,
    {
      spaceId: payload.spaceId,
      channelId: payload.channelId,
      callsign: payload.callsign,
    },
    serviceName
  );

  // Check for registration error
  if ('error' in result) {
    return c.json({ success: false, error: result.error }, 400);
  }

  const service = result;
  console.log(
    `[Register] Container ${payload.callsign} registered ${service.serviceId} on port ${service.port}`
  );

  return c.json({
    success: true,
    serviceToken: service.token,  // Use token from service entry (handles re-registration)
    serviceName: service.serviceId,  // Return full serviceId for rathole config
    controlPort: parseInt(process.env.RATHOLE_CONTROL_PORT || '2333', 10),
    controlHost: process.env.RATHOLE_CONTROL_HOST || undefined,
    assignedPort: service.port,
  });
});

/**
 * DELETE /clients/:serviceId
 *
 * Unregister a tunnel client.
 * Requires CAST_AUTH_TOKEN from the container that originally registered this service.
 *
 * serviceId can be:
 * - {serviceName}-{hash} for named services
 * - {hash} for the default service
 */
app.delete('/clients/:serviceId', async (c) => {
  const serviceId = c.req.param('serviceId');

  // Validate container token
  const authHeader = c.req.header('Authorization');
  const token = extractContainerToken(authHeader);

  if (!token) {
    return c.json({ success: false, error: 'No auth token provided' }, 401);
  }

  const payload = verifyContainerToken(token);
  if (!payload) {
    return c.json({ success: false, error: 'Invalid auth token' }, 401);
  }

  // Verify the requester owns this service
  const owner = getServiceOwner(serviceId);
  if (!owner) {
    // Service exists in TOML but owner unknown (server restarted)
    // Allow deletion if service exists - the container re-registering will reclaim ownership
    const service = getService(serviceId);
    if (!service) {
      return c.json({ success: false, error: 'Service not found' }, 404);
    }
    console.log(`[Unregister] Owner unknown for ${serviceId}, allowing deletion by ${payload.callsign}`);
  } else {
    // Verify ownership: must match spaceId, channelId, and callsign
    if (
      owner.spaceId !== payload.spaceId ||
      owner.channelId !== payload.channelId ||
      owner.callsign !== payload.callsign
    ) {
      console.log(
        `[Unregister] Denied: ${payload.callsign} tried to unregister ${serviceId} owned by ${owner.callsign}`
      );
      return c.json({ success: false, error: 'Not authorized to unregister this service' }, 403);
    }
  }

  const removed = unregisterService(serviceId);
  if (!removed) {
    return c.json({ success: false, error: 'Service not found' }, 404);
  }

  console.log(`[Unregister] Container ${payload.callsign} unregistered ${serviceId}`);
  return c.json({ success: true });
});

// =============================================================================
// Debug endpoints removed for security
// =============================================================================
// GET /clients/:hash and GET /clients were removed because they exposed
// tunnel hashes, which are credentials in the URL-as-auth model.
// See: tunnel-audit-v1 for details.
//
// If admin debugging is needed, add proper authentication or use
// CloudWatch logs / direct ECS exec instead.

// =============================================================================
// Host-Based Service Resolution
// =============================================================================

/**
 * Resolve a Host header to a tunnel service entry.
 *
 * URL formats:
 * - {hash}.domain           -> serviceId = {hash} (default service)
 * - {serviceName}-{hash}.domain -> serviceId = {serviceName}-{hash} (named service)
 *
 * @returns service entry and serviceId, or error string
 */
function resolveService(host: string): { service: NonNullable<ReturnType<typeof getService>>; serviceId: string } | { error: string } {
  const subdomainMatch = host.match(/^([a-z0-9-]+)\./);
  if (!subdomainMatch) {
    return { error: 'Invalid host format' };
  }

  const subdomain = subdomainMatch[1];
  const serviceMatch = subdomain.match(/^(?:([a-z0-9]+)-)?([a-f0-9]{32,})$/);
  if (!serviceMatch) {
    return { error: 'Invalid tunnel URL format' };
  }

  const serviceName = serviceMatch[1];
  const hash = serviceMatch[2];
  const serviceId = serviceName ? `${serviceName}-${hash}` : hash;
  const service = getService(serviceId);

  if (!service) {
    return { error: 'Tunnel not found' };
  }

  return { service, serviceId };
}

// =============================================================================
// Host-Based Routing Proxy
// =============================================================================

/**
 * Catch-all handler for user traffic (HTTP only — WebSocket upgrades
 * are handled separately via the server 'upgrade' event).
 *
 * Note: This is a simple implementation. For production, consider using
 * a dedicated reverse proxy like nginx for better performance.
 */
app.all('*', async (c) => {
  const host = c.req.header('Host');
  if (!host) {
    return c.json({ error: 'No Host header' }, 400);
  }

  const resolved = resolveService(host);
  if ('error' in resolved) {
    return c.json({ error: resolved.error }, resolved.error === 'Tunnel not found' ? 404 : 400);
  }

  const { service, serviceId } = resolved;

  // Proxy to rathole port
  const targetUrl = new URL(c.req.url);
  targetUrl.host = `localhost:${service.port}`;
  targetUrl.protocol = 'http:';

  console.log(`[Proxy] Starting proxy request to ${serviceId} on port ${service.port}`);
  console.log(`[Proxy] Target URL: ${targetUrl.toString()}`);
  console.log(`[Proxy] Method: ${c.req.method}, Path: ${new URL(c.req.url).pathname}`);

  // First, test raw TCP connectivity to the rathole port
  const tcpTestStart = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: service.port }, () => {
        console.log(`[Proxy] TCP connect to port ${service.port} succeeded in ${Date.now() - tcpTestStart}ms`);
        socket.end();
        resolve();
      });
      socket.on('error', (err) => {
        console.error(`[Proxy] TCP connect to port ${service.port} failed:`, err.message);
        reject(err);
      });
      socket.setTimeout(5000, () => {
        console.error(`[Proxy] TCP connect to port ${service.port} timed out`);
        socket.destroy();
        reject(new Error('TCP connect timeout'));
      });
    });
  } catch (tcpErr) {
    console.error(`[Proxy] TCP test failed for ${serviceId}:`, tcpErr);
    return c.json({ error: 'Tunnel port not responding', details: String(tcpErr) }, 502);
  }

  try {
    console.log(`[Proxy] Creating fetch request to ${targetUrl.toString()}`);
    const proxyReq = new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      duplex: 'half',
    });

    console.log(`[Proxy] Executing fetch...`);
    const fetchStart = Date.now();
    const response = await fetch(proxyReq);
    console.log(`[Proxy] Fetch completed in ${Date.now() - fetchStart}ms, status: ${response.status}`);

    // Return proxied response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    console.error(`[Proxy] Error proxying to ${serviceId}:`, error);
    return c.json({ error: 'Proxy error', details: String(error) }, 502);
  }
});

// =============================================================================
// Server Startup (manual createServer for WebSocket upgrade support)
// =============================================================================

const port = parseInt(process.env.PORT || '8080', 10);

console.log(`[TunnelServer] Starting on port ${port}`);
console.log(`[TunnelServer] Rathole control port: ${process.env.RATHOLE_CONTROL_PORT || '2333'}`);

// Create HTTP server manually so we can handle 'upgrade' events for WebSocket
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      headers.set(key, Array.isArray(value) ? value[0] : value);
    }
  }

  const fetchReq = new Request(url.toString(), {
    method: req.method,
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
    duplex: 'half',
  } as RequestInit);

  const response = await app.fetch(fetchReq);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (response.body) {
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    pump().catch((err) => {
      console.error('[HTTP] Response stream error:', err);
      res.end();
    });
  } else {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// WebSocket Upgrade Handler
// ---------------------------------------------------------------------------
// Intercepts HTTP upgrade requests and pipes the raw TCP socket through to
// the rathole port, allowing WebSocket connections to pass through the tunnel.

server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
  const host = request.headers.host;
  if (!host) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const resolved = resolveService(host);
  if ('error' in resolved) {
    const status = resolved.error === 'Tunnel not found' ? 404 : 400;
    socket.write(`HTTP/1.1 ${status} ${resolved.error}\r\n\r\n`);
    socket.destroy();
    return;
  }

  const { service, serviceId } = resolved;
  console.log(`[WS Proxy] Upgrading connection for ${serviceId} -> port ${service.port}`);

  // Connect to the rathole port and pipe the upgrade through
  const target = createConnection({ host: '127.0.0.1', port: service.port }, () => {
    // Reconstruct the original HTTP upgrade request to send to the target
    const path = request.url ?? '/';
    let rawRequest = `${request.method} ${path} HTTP/1.1\r\n`;
    // Forward all original headers
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      rawRequest += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
    }
    rawRequest += '\r\n';

    target.write(rawRequest);
    if (head.length > 0) {
      target.write(head);
    }

    // Bidirectional pipe
    socket.pipe(target);
    target.pipe(socket);
  });

  target.on('error', (err) => {
    console.error(`[WS Proxy] Connection to port ${service.port} failed:`, err.message);
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
  });

  socket.on('error', (err) => {
    console.error(`[WS Proxy] Client socket error:`, err.message);
    target.destroy();
  });
});

server.listen(port, () => {
  console.log(`[TunnelServer] Listening on http://localhost:${port}`);
});
