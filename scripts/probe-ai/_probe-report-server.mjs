/**
 * 临时：接收探针页面用 sendBeacon 回传的结果，追加写入 /tmp/probe-report.txt。
 * 用完即删。
 */
import http from 'node:http';
import fs from 'node:fs';

const OUT = 'F:/L练习/鬼畜哈吉米/.probe-report.txt';
fs.writeFileSync(OUT, '');

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': '*',
      });
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (body) {
        fs.appendFileSync(OUT, body + '\n');
        console.log(body);
      }
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  })
  .listen(8799, '127.0.0.1', () => console.log('[report-server] listening on 8799 -> ' + OUT));
