import { runAutoCashouts, settleLostBets, recoverPayments } from './bets.js';
import { config } from './config.js';
import { activeFaults } from './faults.js';
import { startGame, stopGame, fatal } from './game.js';
import { createHttpServer } from './http.js';
import { log } from './log.js';
import { attachStream } from './stream.js';
import { store } from './runtime.js';

await store.migrate();
await store.seedPlayer();
const lease = await store.pool.connect();
const lock = await lease.query('SELECT pg_try_advisory_lock(487322) AS owned');
if (!lock.rows[0].owned) throw new Error('Another engine already owns the round clock');
lease.on('error', fatal);
await store.recoverInterrupted();
const server = createHttpServer();
attachStream(server);
await startGame({ onMultiplier: runAutoCashouts, onCrash: settleLostBets });
server.listen(config.port, () => log.info('crashsim listening', { port: config.port, ...activeFaults() }));
const worker = setInterval(() => recoverPayments().catch(fatal), 1000);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopGame(); clearInterval(worker);
    server.close();
    lease.release();
    await store.close();
    process.exit(0);
  });
}
