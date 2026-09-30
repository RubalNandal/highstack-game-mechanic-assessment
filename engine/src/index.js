import { runAutoCashouts, settleLostBets } from './bets.js';
import { config } from './config.js';
import { activeFaults } from './faults.js';
import { startGame } from './game.js';
import { createHttpServer } from './http.js';
import { log } from './log.js';
import { attachStream } from './stream.js';

const server = createHttpServer();
attachStream(server);

startGame({ onMultiplier: runAutoCashouts, onCrash: settleLostBets });

server.listen(config.port, () => {
  log.info('crashsim listening', { port: config.port, operatorUrl: config.operatorUrl, ...activeFaults() });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(0));
}
