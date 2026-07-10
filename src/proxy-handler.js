const net = require('net');
const dgram = require('dgram');
const { processVlessHeader, safeCloseWebSocket, base64ToArrayBuffer, WS_READY_STATE_OPEN } = require('./vless-protocol');

const DOH_URL = 'https://dns.google/dns-query';

function handleVlessOverWS(ws, req, config) {
  const userID = config.uuid;
  const proxyIPs = config.proxyIPs || [];
  let proxyIP = proxyIPs.length > 0 ? proxyIPs[Math.floor(Math.random() * proxyIPs.length)] : null;

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.includes('/pyip=')) {
    const tmp_ip = url.pathname.split('=')[1];
    if (tmp_ip && isValidIP(tmp_ip)) {
      proxyIP = tmp_ip;
    }
  }

  let address = '';
  let portWithRandomLog = '';
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };

  const earlyDataHeader = req.headers['sec-websocket-protocol'] || '';

  let remoteSocket = null;
  let udpSocket = null;
  let isDns = false;
  let headerParsed = false;
  let vlessResponseHeader = null;
  let hasIncomingData = false;

  const cleanup = () => {
    if (remoteSocket && !remoteSocket.destroyed) {
      remoteSocket.destroy();
    }
    if (udpSocket) {
      udpSocket.close();
    }
    safeCloseWebSocket(ws);
  };

  let messageQueue = [];
  let isProcessing = false;

  const processMessage = async (data) => {
    if (isDns && udpSocket) {
      handleUDPMessage(data, udpSocket, ws, vlessResponseHeader, log);
      return;
    }

    if (remoteSocket && !remoteSocket.destroyed && headerParsed) {
      remoteSocket.write(Buffer.from(data));
      return;
    }

    if (!headerParsed) {
      messageQueue.push(Buffer.from(data));
      if (isProcessing) return;
      isProcessing = true;

      try {
        const totalBuf = Buffer.concat(messageQueue);
        const result = processVlessHeader(totalBuf, userID);

        if (result.hasError) {
          log('VLESS header error:', result.message);
          cleanup();
          return;
        }

        address = result.addressRemote;
        portWithRandomLog = `${result.portRemote}--${Math.random()} ${result.isUDP ? 'udp ' : 'tcp '} `;

        if (result.isUDP) {
          if (result.portRemote === 53) {
            isDns = true;
          } else {
            log('UDP proxy only enable for DNS which is port 53');
            cleanup();
            return;
          }
        }

        vlessResponseHeader = new Uint8Array([result.vlessVersion[0], 0]);
        const rawClientData = totalBuf.slice(result.rawDataIndex);
        headerParsed = true;
        messageQueue = null;

        if (isDns) {
          handleUDPOutbound(ws, vlessResponseHeader, log, (socket) => {
            udpSocket = socket;
            if (rawClientData.length > 0) {
              handleUDPMessage(rawClientData, udpSocket, ws, vlessResponseHeader, log);
            }
          });
        } else {
          handleTCPOutbound(
            address,
            result.portRemote,
            rawClientData,
            ws,
            vlessResponseHeader,
            proxyIP,
            log,
            (socket) => {
              remoteSocket = socket;
            }
          );
        }
      } catch (err) {
        log('Processing error:', err.message);
        cleanup();
      } finally {
        isProcessing = false;
      }
    }
  };

  const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
  if (error) {
    log('Early data decode error:', error.message);
  } else if (earlyData && earlyData.length > 0) {
    processMessage(earlyData);
  }

  ws.on('message', (data) => {
    processMessage(data);
  });

  ws.on('close', () => {
    log('WebSocket closed');
    if (remoteSocket && !remoteSocket.destroyed) {
      remoteSocket.destroy();
    }
    if (udpSocket) {
      udpSocket.close();
    }
  });

  ws.on('error', (err) => {
    log('WebSocket error:', err.message);
    cleanup();
  });
}

function handleTCPOutbound(address, port, rawClientData, ws, vlessResponseHeader, proxyIP, log, onSocket) {
  let tcpSocket = null;
  let retryDone = false;
  let hasData = false;
  let headerSent = false;

  const connectAndWrite = (addr, p) => {
    const socket = net.connect(p, addr, () => {
      log(`connected to ${addr}:${p}`);
      if (rawClientData.length > 0) {
        socket.write(rawClientData);
      }
    });

    socket.on('data', (chunk) => {
      hasData = true;
      if (ws.readyState !== WS_READY_STATE_OPEN) return;

      if (!headerSent) {
        const combined = Buffer.concat([Buffer.from(vlessResponseHeader), chunk]);
        ws.send(combined);
        headerSent = true;
      } else {
        ws.send(chunk);
      }
    });

    socket.on('end', () => {
      log('remote socket end');
      safeCloseWebSocket(ws);
    });

    socket.on('error', (err) => {
      log(`remote socket error: ${err.message}`);
      if (!retryDone && proxyIP && !hasData) {
        retryDone = true;
        log(`retrying with proxyIP: ${proxyIP}`);
        socket.destroy();
        const retrySocket = connectAndWrite(proxyIP, port);
        onSocket(retrySocket);
      } else {
        safeCloseWebSocket(ws);
      }
    });

    socket.on('close', () => {
      log('remote socket closed');
      if (!hasData && !retryDone && proxyIP) {
        retryDone = true;
        log(`retrying with proxyIP: ${proxyIP}`);
        const retrySocket = connectAndWrite(proxyIP, port);
        onSocket(retrySocket);
      } else {
        safeCloseWebSocket(ws);
      }
    });

    return socket;
  };

  tcpSocket = connectAndWrite(address, port);
  onSocket(tcpSocket);
}

function handleUDPOutbound(ws, vlessResponseHeader, log, onSocketReady) {
  const udpSocket = dgram.createSocket('udp4');
  let isVlessHeaderSent = false;

  udpSocket.on('message', (msg, rinfo) => {
    if (ws.readyState !== WS_READY_STATE_OPEN) return;

    const udpSize = msg.length;
    const udpSizeBuffer = Buffer.alloc(2);
    udpSizeBuffer.writeUInt16BE(udpSize, 0);

    if (isVlessHeaderSent) {
      ws.send(Buffer.concat([udpSizeBuffer, msg]));
    } else {
      ws.send(Buffer.concat([Buffer.from(vlessResponseHeader), udpSizeBuffer, msg]));
      isVlessHeaderSent = true;
    }
    log(`doh success and dns message length is ${udpSize}`);
  });

  udpSocket.on('error', (err) => {
    log('UDP socket error:', err.message);
    safeCloseWebSocket(ws);
  });

  udpSocket.on('close', () => {
    log('UDP socket closed');
  });

  udpSocket.bind(0, () => {
    log('UDP socket bound');
    onSocketReady(udpSocket);
  });
}

function handleUDPMessage(chunk, udpSocket, ws, vlessResponseHeader, log) {
  let index = 0;
  while (index < chunk.byteLength) {
    const lengthBuffer = chunk.slice(index, index + 2);
    const udpPacketLength = new DataView(lengthBuffer.buffer, lengthBuffer.byteOffset, lengthBuffer.length).getUint16(0);
    const udpData = chunk.slice(index + 2, index + 2 + udpPacketLength);
    index = index + 2 + udpPacketLength;

    udpSocket.send(udpData, 53, '8.8.8.8', (err) => {
      if (err) {
        log('UDP send error:', err.message);
      }
    });
  }
}

function isValidIP(ip) {
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::$/;
  return ipv4Regex.test(ip) || ipv6Regex.test(ip) || ip.includes('.');
}

module.exports = {
  handleVlessOverWS,
};
