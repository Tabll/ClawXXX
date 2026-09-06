import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'clawx-runtime-probe',
  register(api) {
    if (process.env.CLAWX_ISOLATED_RUNTIME_PROBE !== '1' || process.env.CLAWX_MANAGED_RUNTIME !== '1') throw new Error('Test-only plugin requires isolated probe mode');
    api.registerGatewayMethod('clawx.test.channels', async ({ params, respond }) => {
      try {
        // Version-specific test seam, never distributed in the runtime. This
        // forces the real loader to execute lazy channel modules without an
        // external account, network login or sending any real message.
        const { t: bootstrap } = await import(pathToFileURL(join(process.env.CLAWX_OPENCLAW_PACKAGE_DIR, 'dist/channel-bootstrap.runtime-B3F9K4Uk.js')).href);
        const results = params.channels.map(channel => {
          const registry = bootstrap({ cfg: api.config, channel, agentId: 'main' });
          const entry = registry?.channels.find(item => item.plugin.id === channel);
          return { channel, sendCapable: Boolean(entry?.plugin.outbound?.sendText ?? entry?.plugin.message?.send?.text), plugins: registry?.plugins.map(({ id, status, error }) => ({ id, status, error })) };
        });
        respond(true, { results });
      } catch (error) { respond(false, undefined, { code: 'INVALID_REQUEST', message: String(error) }); }
    }, { scope: 'operator.admin' });
    api.registerGatewayMethod('clawx.test.ingress', async ({ params, respond }) => {
      try {
        const ctx = api.runtime.channel.reply.finalizeInboundContext({
          Body: params.text, BodyForAgent: params.text, RawBody: params.text,
          From: 'telegram:clawx-probe-peer', To: 'telegram:clawx-probe-bot',
          SessionKey: 'agent:main:telegram:direct:clawx-probe-peer',
          AccountId: 'default', Provider: 'telegram', Surface: 'telegram',
          MessageSid: params.messageId, ChatType: 'direct', SenderId: 'clawx-probe-peer',
          OriginatingChannel: 'telegram', OriginatingTo: 'telegram:clawx-probe-peer',
          CommandAuthorized: true, Timestamp: Date.now(),
        });
        // Exercise older connector pre-dispatch bookkeeping as well as the
        // current reply path. Neither may create native session history.
        await api.runtime.channel.session.recordInboundSession({
          storePath: api.runtime.channel.session.resolveStorePath(api.config.session?.store, { agentId: 'main' }),
          sessionKey: ctx.SessionKey, ctx, onRecordError: error => { throw error; },
          updateLastRoute: { sessionKey: 'agent:main:main', channel: 'telegram', to: ctx.From, accountId: 'default' },
        });
        const result = await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx, cfg: api.config,
          dispatcherOptions: { deliver: async () => { throw new Error('Native channel reply bypassed canonical admission'); } },
        });
        respond(true, { ok: true, result });
      } catch (error) { respond(false, undefined, { code: 'INVALID_REQUEST', message: String(error) }); }
    }, { scope: 'operator.admin' });
  },
};
