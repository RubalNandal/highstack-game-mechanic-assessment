import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { faults } from './faults.js';
import { log } from './log.js';

let seq = 0;
const wss = new WebSocketServer({ noServer: true });

export function currentSeq() {
  return seq;
}

/** Creates an event with the next global sequence number. Does not send it. */
export function createEvent(type, data) {
  seq += 1;
  return { type, seq, data };
}

export function send(event) {
  const message = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
  log.debug('stream event', { type: event.type, seq: event.seq });
}

export function emit(type, data) {
  const event = createEvent(type, data);
  send(event);
  return event;
}

export function attachStream(server) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['x-operator-key'] ?? url.searchParams.get('key');

    if (url.pathname !== '/stream' || key !== config.operatorKey) {
      const status = url.pathname !== '/stream' ? '404 Not Found' : '401 Unauthorized';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      log.info('stream client connected', { clients: wss.clients.size });
      ws.on('close', () => log.info('stream client disconnected', { clients: wss.clients.size }));
    });
  });

  if (faults.dropWsEverySec) {
    setInterval(() => {
      for (const client of wss.clients) client.terminate();
    }, faults.dropWsEverySec * 1000);
  }
}
