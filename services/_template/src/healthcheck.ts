import http from 'node:http';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const options = {
  hostname: '127.0.0.1',
  port,
  path: '/healthz',
  method: 'GET',
  timeout: 4000
};

const req = http.request(options, (res) => {
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});

req.on('error', () => {
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});

req.end();
