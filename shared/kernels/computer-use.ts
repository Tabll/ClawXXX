import type { KernelId } from './contracts';

export type ComputerUseStatus = {
  kernelId: KernelId | null;
  supported: boolean;
  state: 'disabled' | 'unsupported' | 'permissions' | 'unavailable' | 'ready' | 'running' | 'failed';
  accessibility: boolean;
  screenRecording: boolean;
};
export type ComputerToolResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }>;
  isError: boolean;
};
