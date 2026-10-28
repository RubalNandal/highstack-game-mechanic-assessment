import { runAutoCashouts, settleLostBets, recoverPayments } from './bets.js';
import { config } from './config.js';
import { activeFaults } from './faults.js';
import { startGame, stopGame, fatal } from './game.js';
import { createHttpServer } from './http.js';
import { log } from './log.js';
import { attachStream } from './stream.js';
import { operator } from './operator.js';

await operator.start();
const heartbeat = setInterval(() => operator.heartbeat().catch(fatal), 3000);
await recoverPayments();
const server = createHttpServer();
attachStream(server);
await startGame({ onMultiplier: runAutoCashouts, onCrash: settleLostBets });
server.listen(config.port, () =>
  log.info('crashsim listening', { port: config.port, ...activeFaults() }),
);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopGame();
    clearInterval(heartbeat);
    server.close();
    await operator.stop().catch(() => {});
    process.exit(0);
  });
}
