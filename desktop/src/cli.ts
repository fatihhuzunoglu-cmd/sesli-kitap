// Runs the computer app's server without a window: for tests, or on a computer that only shares its library.
// node dist/cli.mjs [--port 47800] [--library DIR] [--token CODE] [--strict] [--catalog http://host:port]
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const catalog = opt('catalog');
const server = await startServer({
  port: parseInt(opt('port') ?? '47800', 10),
  libraryDir: opt('library') ?? join(homedir(), 'Documents', 'Sesli Kitap'),
  staticDir: dirname(fileURLToPath(import.meta.url)),
  version: process.env.npm_package_version ?? 'cli',
  token: opt('token'),
  trustLoopback: !args.includes('--strict'),
  catalogBases: catalog ? { archive: `${catalog}/mock-archive`, gutendex: `${catalog}/mock-gutendex` } : undefined,
  log: (line) => console.log(line),
});
const stop = () => void server.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
