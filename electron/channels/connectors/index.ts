import { resolve } from 'node:path';
import { renderQrPngDataUrl } from '../../utils/wechat-login';
import type { ChannelConnectorRegistry } from '../channel-connector-registry';
import { createDingTalkConnectorFactory } from './dingtalk';
import { createDiscordConnectorFactory } from './discord';
import { createFeishuConnectorFactory } from './feishu';
import { createQQBotConnectorFactory } from './qqbot';
import { createTelegramConnectorFactory } from './telegram';
import { createWeComConnectorFactory } from './wecom';
import { createWeChatConnectorFactory } from './wechat';
import { createWhatsAppConnectorFactory } from './whatsapp';

export type BuiltinChannelConnectorOptions = {
  projectionRoot: string;
  persistCredential(accountId: string, values: Record<string, string>): Promise<void>;
};

/** Register the full, UI-supported connector matrix or fail startup loudly. */
export function registerBuiltinChannelConnectors(
  registry: ChannelConnectorRegistry,
  options: BuiltinChannelConnectorOptions,
): void {
  const factories = [
    createTelegramConnectorFactory(),
    createDiscordConnectorFactory(),
    createWhatsAppConnectorFactory({
      projectionRoot: resolve(options.projectionRoot, 'whatsapp'),
      persistCredential: options.persistCredential,
      renderQr: renderQrPngDataUrl,
    }),
    createWeChatConnectorFactory(),
    createDingTalkConnectorFactory(),
    createFeishuConnectorFactory(),
    createWeComConnectorFactory(),
    createQQBotConnectorFactory(),
  ];
  for (const factory of factories) registry.register(factory);
  const missing = registry.missingBuiltins();
  if (missing.length > 0) throw new Error(`Missing built-in Channel Relay connectors: ${missing.join(', ')}`);
}
