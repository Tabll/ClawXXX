import type { CompleteHostServiceRegistry } from '../main/ipc/host-contract';
import type { ComputerUseService } from './computer-use';

export function createComputerUseApi(service?: ComputerUseService): CompleteHostServiceRegistry['computerUse'] {
  const requireService = () => { if (!service) throw new Error('Computer Use unavailable'); return service; };
  return {
    status: () => requireService().status(),
    select: payload => requireService().select(payload?.kernelId),
    requestPermissions: () => requireService().requestPermissions(),
  };
}
