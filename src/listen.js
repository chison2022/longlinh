// Start the HTTP server and resolve only once it is really listening (rejects with the listen error, e.g. EADDRINUSE).
// Bound to 127.0.0.1 by default: the web part is for the local machine only (override with BIND_HOST).
const http = require('node:http');

function listen(app, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { listen };
