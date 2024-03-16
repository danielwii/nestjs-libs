import { Logger } from '@nestjs/common';

import { f } from '@app/utils';

import https from 'node:https';

import { HttpsProxyAgent } from 'https-proxy-agent';

import { AppEnv } from './configure';

const proxy = `${AppEnv.APP_PROXY_HOST}:${AppEnv.APP_PROXY_PORT}`;
export const Proxy = {
  agent: AppEnv.APP_PROXY_ENABLED ? new HttpsProxyAgent(proxy) : undefined,
  unauthorizedAgent: AppEnv.APP_PROXY_ENABLED
    ? new HttpsProxyAgent(proxy, { rejectUnauthorized: false })
    : new https.Agent({ rejectUnauthorized: false }),
};

if (AppEnv.APP_PROXY_ENABLED) {
  Logger.log(f`init with url ${proxy}`, Proxy.constructor.name);
}
