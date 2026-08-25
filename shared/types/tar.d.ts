declare module 'tar' {
  import type { Duplex } from 'node:stream';

  export type ReadEntry = {
    path: string;
    type: string;
    size: number;
    mode?: number;
    linkpath?: string;
  };

  export type StreamOptions = {
    cwd?: string;
    strict?: boolean;
    preservePaths?: boolean;
    unlink?: boolean;
    onentry?: (entry: ReadEntry) => void;
    filter?: (path: string, entry: ReadEntry) => boolean;
  };

  export function t(options: StreamOptions): Duplex;
  export function x(options: StreamOptions): Duplex;
}
