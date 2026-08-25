import { DataServiceRpcServer } from './data-service-rpc-server';
import type { DataServiceRpcRequest } from '@shared/data/rpc';

type ParentPort = {
  on(event: 'message', listener: (event: { data?: unknown } | unknown) => void): void;
  postMessage(message: unknown): void;
};

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const databasePath = process.env.CLAWX_DATA_DATABASE_PATH;
const blobRoot = process.env.CLAWX_DATA_BLOB_ROOT;

if (!parentPort || !databasePath || !blobRoot) {
  process.stderr.write('ClawX DataService requires an Electron parent port and owner paths\n');
  process.exit(64);
}

const server = new DataServiceRpcServer(databasePath, blobRoot);
parentPort.postMessage(server.ready());
parentPort.on('message', event => {
  const request = ((event as { data?: unknown })?.data ?? event) as DataServiceRpcRequest;
  void server.handle(request).then(response => {
    parentPort.postMessage(response);
    if (request.method === 'service.shutdown') setImmediate(() => process.exit(0));
  });
});
