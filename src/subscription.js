const httpPorts = ['80', '8080', '8880', '2052', '2082', '2086', '2095'];
const httpsPorts = ['443', '8443', '2053', '2083', '2087', '2096'];

const httpIPs = [
  'www.visa.com',
  'cis.visa.com',
  'africa.visa.com',
  'www.visa.com.sg',
  'www.visaeurope.at',
  'www.visa.com.mt',
  'qa.visamiddleeast.com',
];

const httpsIPs = [
  'usa.visa.com',
  'myanmar.visa.com',
  'www.visa.com.tw',
  'www.visaeurope.ch',
  'www.visa.com.br',
  'www.visasoutheasteurope.com',
];

function buildVLESSUri(userID, host, port, tls, hostName, path = '/?ed=2560') {
  const params = new URLSearchParams();
  params.set('encryption', 'none');
  params.set('type', 'ws');
  params.set('host', hostName);
  params.set('path', encodeURIComponent(path));
  params.set('fp', 'randomized');
  
  if (tls) {
    params.set('security', 'tls');
    params.set('sni', hostName);
  } else {
    params.set('security', 'none');
  }

  return `vless://${userID}@${host}:${port}?${params.toString()}#${encodeURIComponent(`${hostName}_${port}`)}`;
}

function generateSubscriptionBase64(userID, hostName, tlsOnly = false) {
  const lines = [];

  if (!tlsOnly) {
    for (let i = 0; i < httpIPs.length && i < httpPorts.length; i++) {
      const uri = buildVLESSUri(userID, httpIPs[i], httpPorts[i], false, hostName);
      const name = `VLESS_H${i + 1}_${httpIPs[i]}_${httpPorts[i]}`;
      lines.push(uri.replace(/#.*$/, `#${encodeURIComponent(name)}`));
    }
  }

  for (let i = 0; i < httpsIPs.length && i < httpsPorts.length; i++) {
    const uri = buildVLESSUri(userID, httpsIPs[i], httpsPorts[i], true, hostName);
    const name = `VLESS_S${i + 1}_${httpsIPs[i]}_${httpsPorts[i]}`;
    lines.push(uri.replace(/#.*$/, `#${encodeURIComponent(name)}`));
  }

  return Buffer.from(lines.join('\n')).toString('base64');
}

function generateClashConfig(userID, hostName, tlsOnly = false) {
  const proxies = [];
  const proxyNames = [];

  if (!tlsOnly) {
    for (let i = 0; i < httpIPs.length && i < httpPorts.length; i++) {
      const name = `VLESS_H${i + 1}_${httpIPs[i]}_${httpPorts[i]}`;
      proxyNames.push(name);
      proxies.push({
        name,
        type: 'vless',
        server: httpIPs[i],
        port: parseInt(httpPorts[i]),
        uuid: userID,
        udp: false,
        tls: false,
        network: 'ws',
        'ws-opts': {
          path: '/?ed=2560',
          headers: {
            Host: hostName,
          },
        },
      });
    }
  }

  for (let i = 0; i < httpsIPs.length && i < httpsPorts.length; i++) {
    const name = `VLESS_S${i + 1}_${httpsIPs[i]}_${httpsPorts[i]}`;
    proxyNames.push(name);
    proxies.push({
      name,
      type: 'vless',
      server: httpsIPs[i],
      port: parseInt(httpsPorts[i]),
      uuid: userID,
      udp: false,
      tls: true,
      network: 'ws',
      servername: hostName,
      'ws-opts': {
        path: '/?ed=2560',
        headers: {
          Host: hostName,
        },
      },
    });
  }

  const config = `
port: 7890
allow-lan: true
mode: rule
log-level: info
unified-delay: true
global-client-fingerprint: chrome
dns:
  enable: true
  listen: :53
  ipv6: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  default-nameserver:
    - 223.5.5.5
    - 114.114.114.114
    - 8.8.8.8
  nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  fallback:
    - https://1.0.0.1/dns-query
    - tls://dns.google
  fallback-filter:
    geoip: true
    geoip-code: CN
    ipcidr:
      - 240.0.0.0/4

proxies:
${proxies.map((p) => yamlStringify(p, 1)).join('\n')}

proxy-groups:
- name: 负载均衡
  type: load-balance
  url: http://www.gstatic.com/generate_204
  interval: 300
  proxies:
${proxyNames.map((n) => `    - ${n}`).join('\n')}

- name: 自动选择
  type: url-test
  url: http://www.gstatic.com/generate_204
  interval: 300
  tolerance: 50
  proxies:
${proxyNames.map((n) => `    - ${n}`).join('\n')}

- name: 🌍选择代理
  type: select
  proxies:
    - 负载均衡
    - 自动选择
    - DIRECT
${proxyNames.map((n) => `    - ${n}`).join('\n')}

rules:
  - GEOIP,LAN,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,🌍选择代理
`;

  return config.trim();
}

function generateSingBoxConfig(userID, hostName, tlsOnly = false) {
  const outbounds = [];
  const outboundTags = [];

  if (!tlsOnly) {
    for (let i = 0; i < httpIPs.length && i < httpPorts.length; i++) {
      const tag = `VLESS_H${i + 1}_${httpIPs[i]}_${httpPorts[i]}`;
      outboundTags.push(tag);
      outbounds.push({
        server: httpIPs[i],
        server_port: parseInt(httpPorts[i]),
        tag,
        packet_encoding: 'packetaddr',
        transport: {
          headers: {
            Host: [hostName],
          },
          path: '/?ed=2560',
          type: 'ws',
        },
        type: 'vless',
        uuid: userID,
      });
    }
  }

  for (let i = 0; i < httpsIPs.length && i < httpsPorts.length; i++) {
    const tag = `VLESS_S${i + 1}_${httpsIPs[i]}_${httpsPorts[i]}`;
    outboundTags.push(tag);
    outbounds.push({
      server: httpsIPs[i],
      server_port: parseInt(httpsPorts[i]),
      tag,
      tls: {
        enabled: true,
        server_name: hostName,
        insecure: false,
        utls: {
          enabled: true,
          fingerprint: 'chrome',
        },
      },
      packet_encoding: 'packetaddr',
      transport: {
        headers: {
          Host: [hostName],
        },
        path: '/?ed=2560',
        type: 'ws',
      },
      type: 'vless',
      uuid: userID,
    });
  }

  const config = {
    log: {
      disabled: false,
      level: 'info',
      timestamp: true,
    },
    dns: {
      servers: [
        {
          tag: 'proxydns',
          address: 'tls://8.8.8.8/dns-query',
          detour: 'select',
        },
        {
          tag: 'localdns',
          address: 'https://223.5.5.5/dns-query',
          detour: 'direct',
        },
        {
          address: 'rcode://refused',
          tag: 'block',
        },
        {
          tag: 'dns_fakeip',
          address: 'fakeip',
        },
      ],
      fakeip: {
        enabled: true,
        inet4_range: '198.18.0.0/15',
        inet6_range: 'fc00::/18',
      },
      independent_cache: true,
      final: 'proxydns',
    },
    inbounds: [
      {
        type: 'mixed',
        listen: '127.0.0.1',
        listen_port: 7890,
      },
    ],
    outbounds: [
      {
        tag: 'select',
        type: 'selector',
        default: 'auto',
        outbounds: ['auto', ...outboundTags],
      },
      ...outbounds,
      {
        tag: 'direct',
        type: 'direct',
      },
      {
        tag: 'block',
        type: 'block',
      },
      {
        tag: 'dns-out',
        type: 'dns',
      },
      {
        tag: 'auto',
        type: 'urltest',
        outbounds: outboundTags,
        url: 'https://www.gstatic.com/generate_204',
        interval: '1m',
        tolerance: 50,
        interrupt_exist_connections: false,
      },
    ],
    route: {
      auto_detect_interface: true,
      final: 'select',
      rules: [
        {
          outbound: 'dns-out',
          protocol: 'dns',
        },
        {
          ip_is_private: true,
          outbound: 'direct',
        },
      ],
    },
  };

  return JSON.stringify(config, null, 2);
}

function yamlStringify(obj, indent = 0) {
  const spaces = '  '.repeat(indent);
  let result = '';

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result += `${spaces}- ${key}:\n${yamlStringify(value, indent + 1).replace(/^/gm, '  ').slice(2)}\n`;
    } else if (Array.isArray(value)) {
      result += `${spaces}- ${key}:\n`;
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          result += `${spaces}    ${yamlStringify(item, indent + 2).slice(2)}\n`;
        } else {
          result += `${spaces}    - ${item}\n`;
        }
      }
    } else {
      result += `${spaces}- ${key}: ${value}\n`;
    }
  }

  return result;
}

function generateWebPage(userID, hostName, config) {
  const proxyIP = (config.proxyIPs && config.proxyIPs.length > 0) ? config.proxyIPs[0] : '未配置';
  const wsPath = config.path || '/?ed=2560';
  
  const tlsUri = buildVLESSUri(userID, hostName, '443', true, hostName, wsPath);
  const noTlsUri = buildVLESSUri(userID, hostName, '8080', false, hostName, wsPath);

  const tyUrl = `https://${hostName}/${userID}/ty`;
  const clUrl = `https://${hostName}/${userID}/cl`;
  const sbUrl = `https://${hostName}/${userID}/sb`;
  const ptyUrl = `https://${hostName}/${userID}/pty`;
  const pclUrl = `https://${hostName}/${userID}/pcl`;
  const psbUrl = `https://${hostName}/${userID}/psb`;

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<style>
.limited-width {
    max-width: 300px;
    overflow: auto;
    word-wrap: break-word;
}
.container {
    margin-top: 30px;
}
</style>
<script>
function copyToClipboard(text) {
  const input = document.createElement('textarea');
  input.style.position = 'fixed';
  input.style.opacity = 0;
  input.value = text;
  document.body.appendChild(input);
  input.select();
  document.execCommand('Copy');
  document.body.removeChild(input);
  alert('已复制到剪贴板');
}
</script>
</head>
<body>
<div class="container">
    <div class="row">
        <div class="col-md-12">
            <h1>VLESS 反向代理服务器</h1>
            <hr>
            <p>当前ProxyIP：${proxyIP}</p>
            <hr>
            
            <h3>1. VLESS + WS + TLS 节点</h3>
            <table class="table">
                <thead>
                    <tr>
                        <th>说明</th>
                        <th>节点链接</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>启用TLS加密</td>
                        <td class="limited-width">${tlsUri}</td>
                        <td><button class="btn btn-primary" onclick="copyToClipboard('${tlsUri}')">复制</button></td>
                    </tr>
                </tbody>
            </table>
            
            <h3>2. VLESS + WS 节点（无TLS）</h3>
            <table class="table">
                <thead>
                    <tr>
                        <th>说明</th>
                        <th>节点链接</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>无TLS加密</td>
                        <td class="limited-width">${noTlsUri}</td>
                        <td><button class="btn btn-primary" onclick="copyToClipboard('${noTlsUri}')">复制</button></td>
                    </tr>
                </tbody>
            </table>

            <h3>3. 客户端参数</h3>
            <ul>
                <li>用户ID(UUID)：${userID}</li>
                <li>传输协议：ws / websocket</li>
                <li>伪装域名(Host)：${hostName}</li>
                <li>路径：${wsPath}</li>
                <li>TLS：开启/关闭</li>
            </ul>
            <hr>

            <h3>4. 订阅链接</h3>
            <p>注意：订阅链接包含多个优选IP节点，需通过代理访问</p>
            <table class="table">
                <thead>
                    <tr>
                        <th>类型</th>
                        <th>链接</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>通用订阅（含TLS+非TLS）</td>
                        <td class="limited-width">${tyUrl}</td>
                        <td><button class="btn btn-primary" onclick="copyToClipboard('${tyUrl}')">复制</button></td>
                    </tr>
                    <tr>
                        <td>Clash订阅（含TLS+非TLS）</td>
                        <td class="limited-width">${clUrl}</td>
                        <td><button class="btn btn-primary" onclick="copyToClipboard('${clUrl}')">复制</button></td>
                    </tr>
                    <tr>
                        <td>Sing-box订阅（含TLS+非TLS）</td>
                        <td class="limited-width">${sbUrl}</td>
                        <td><button class="btn btn-primary" onclick="copyToClipboard('${sbUrl}')">复制</button></td>
                    </tr>
                    <tr>
                        <td>通用订阅（仅TLS）</td>
                        <td class="limited-width">${ptyUrl}</td>
                        <td><button class="btn btn-primary" onclick="copyToClipboard('${ptyUrl}')">复制</button></td>
                    </tr>
                    <tr>
                        <td>Clash订阅（仅TLS）</td>
                        <td class="limited-width">${pclUrl}</td>
                        <td><button class="btn btn-primary" onclick="copyToClipboard('${pclUrl}')">复制</button></td>
                    </tr>
                    <tr>
                        <td>Sing-box订阅（仅TLS）</td>
                        <td class="limited-width">${psbUrl}</td>
                        <td><button class="btn btn-primary" onclick="copyToClipboard('${psbUrl}')">复制</button></td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</div>
</body>
</html>
`;
}

module.exports = {
  buildVLESSUri,
  generateSubscriptionBase64,
  generateClashConfig,
  generateSingBoxConfig,
  generateWebPage,
  httpIPs,
  httpsIPs,
  httpPorts,
  httpsPorts,
};
