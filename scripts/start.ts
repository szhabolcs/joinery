/** `start-joinery.cmd`: run the server from this checkout and open the UI once it's listening. */
import { configuredPort, openCommand } from '../apps/server/src/runtime.ts';
import { startServer } from '../apps/server/src/start.ts';

await startServer();
Bun.spawn(openCommand(`http://127.0.0.1:${String(configuredPort())}/`), { stdout: 'ignore', stderr: 'ignore' });
