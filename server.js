const http = require('http');
const os = require('os');
const { handleRequest } = require('./server-core');

const server = http.createServer(handleRequest);

module.exports = server;

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Shift Schedule server is running.');
    console.log('  Local:    http://localhost:' + PORT);
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log('  Network:  http://' + iface.address + ':' + PORT);
        }
      }
    }
    console.log('  Admin:    username admin  /  password admin123');
    console.log('            change with:  node server.js --set-password YOURNEWPASS');
    console.log('');
  });
}