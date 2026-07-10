const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const net = require('net');
const { handleVlessOverWS } = require('./proxy-handler');
const {
  generateSubscriptionBase64,
  generateClashConfig,
  generateSingBoxConfig,
  generateWebPage,
} = require('./subscription');
const { isValidUUID } = require('./vless-protocol');

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw);

  if (!isValidUUID(config.vless.uuid)) {
    console.warn('Warning: Invalid UUID format in config, using default');
    config.vless.uuid = '550e8400-e29b-41d4-a716-446655440000';
  }

  return config;
}

function createFallbackHandler(config) {
  return (req, res) => {
    if (!config.fallback || !config.fallback.enabled) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const options = {
      hostname: config.fallback.host,
      port: config.fallback.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: config.fallback.host,
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[Fallback] Proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    });

    req.pipe(proxyReq);
  };
}

function handleHttpRequest(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const userID = config.vless.uuid;
  const hostName = req.headers.host;

  const pathName = url.pathname;

  if (pathName === `/${userID}`) {
    const html = generateWebPage(userID, hostName, config.vless);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (pathName === `/${userID}/ty`) {
    const content = generateSubscriptionBase64(userID, hostName, false);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Subscription-Userinfo': 'upload=0; download=0; total=0; expire=0',
      'profile-update-interval': '24',
    });
    res.end(content);
    return;
  }

  if (pathName === `/${userID}/cl`) {
    const content = generateClashConfig(userID, hostName, false);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(content);
    return;
  }

  if (pathName === `/${userID}/sb`) {
    const content = generateSingBoxConfig(userID, hostName, false);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(content);
    return;
  }

  if (pathName === `/${userID}/pty`) {
    const content = generateSubscriptionBase64(userID, hostName, true);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Subscription-Userinfo': 'upload=0; download=0; total=0; expire=0',
      'profile-update-interval': '24',
    });
    res.end(content);
    return;
  }

  if (pathName === `/${userID}/pcl`) {
    const content = generateClashConfig(userID, hostName, true);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(content);
    return;
  }

  if (pathName === `/${userID}/psb`) {
    const content = generateSingBoxConfig(userID, hostName, true);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(content);
    return;
  }

  const fallbackHandler = createFallbackHandler(config);
  fallbackHandler(req, res);
}

function createServer(config) {
  let server;
  let wss;

  const requestHandler = (req, res) => {
    handleHttpRequest(req, res, config);
  };

  if (config.server.tls.enabled) {
    const certPath = path.resolve(config.server.tls.certPath);
    const keyPath = path.resolve(config.server.tls.keyPath);

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.warn('[TLS] Certificate files not found. Please run: npm run gen-cert');
      console.warn('[TLS] Continuing without TLS...');
      config.server.tls.enabled = false;
      server = http.createServer(requestHandler);
    } else {
      const tlsOptions = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      };
      server = https.createServer(tlsOptions, requestHandler);
      console.log('[Server] TLS enabled');
    }
  } else {
    server = http.createServer(requestHandler);
    console.log('[Server] TLS disabled');
  }

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userID = config.vless.uuid;

    const isVlessPath = url.pathname === '/' + userID ||
      url.pathname.startsWith('/' + userID + '/') ||
      url.pathname === config.vless.path ||
      url.pathname.includes('/pyip=');

    if (isVlessPath) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleVlessOverWS(ws, req, config.vless);
      });
    } else if (config.fallback && config.fallback.enabled) {
      const fallbackSocket = net.connect(config.fallback.port, config.fallback.host, () => {
        let header = `GET ${req.url} HTTP/1.1\r\nHost: ${config.fallback.host}\r\n`;
        for (const [key, value] of Object.entries(req.headers)) {
          if (key.toLowerCase() !== 'host') {
            header += `${key}: ${value}\r\n`;
          }
        }
        header += '\r\n';
        fallbackSocket.write(header);
        fallbackSocket.pipe(socket);
        socket.pipe(fallbackSocket);
      });

      fallbackSocket.on('error', () => {
        socket.destroy();
      });
    } else {
      socket.destroy();
    }
  });

  return server;
}

function main() {
  const config = loadConfig();
  const server = createServer(config);

  const host = config.server.host;
  const port = config.server.port;

  server.listen(port, host, () => {
    const protocol = config.server.tls.enabled ? 'https' : 'http';
    console.log(`[Server] Listening on ${host}:${port}`);
    console.log(`[Server] URL: ${protocol}://${host}:${port}`);
    console.log(`[VLESS] UUID: ${config.vless.uuid}`);
    console.log(`[Web] 管理页面: ${protocol}://${host}:${port}/${config.vless.uuid}`);
    console.log(`[订阅] 通用: ${protocol}://${host}:${port}/${config.vless.uuid}/ty`);
    console.log(`[订阅] Clash: ${protocol}://${host}:${port}/${config.vless.uuid}/cl`);
    console.log(`[订阅] Sing-box: ${protocol}://${host}:${port}/${config.vless.uuid}/sb`);
    if (config.fallback && config.fallback.enabled) {
      console.log(`[Fallback] ${config.fallback.host}:${config.fallback.port}`);
    }
  });

  server.on('error', (err) => {
    console.error('[Server] Error:', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try a different port.`);
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, loadConfig };
