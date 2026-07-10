const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function generateCerts() {
  const certDir = path.join(__dirname, '..', 'certs');
  const certPath = path.join(certDir, 'server.crt');
  const keyPath = path.join(certDir, 'server.key');

  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    console.log('Certificate files already exist.');
    return;
  }

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 365 -subj "/CN=localhost/O=VLESS Proxy/C=US"`,
      { stdio: 'inherit' }
    );
    console.log('Self-signed certificate generated successfully:');
    console.log(`  Cert: ${certPath}`);
    console.log(`  Key:  ${keyPath}`);
  } catch (err) {
    console.error('Failed to generate certificate. Please ensure OpenSSL is installed.');
    console.error(err.message);
    process.exit(1);
  }
}

generateCerts();
