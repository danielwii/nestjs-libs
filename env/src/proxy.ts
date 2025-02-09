import { HttpsProxyAgent } from 'https-proxy-agent';
import { Logger } from '@nestjs/common';

import { AppEnv } from './configure';
import { f } from '@app/utils';
import https from 'node:https';

const proxy = AppEnv.APP_PROXY_ENABLED ? `${AppEnv.APP_PROXY_HOST}:${AppEnv.APP_PROXY_PORT}` : '';
export const Proxy = {
  agent: AppEnv.APP_PROXY_ENABLED ? new HttpsProxyAgent(proxy) : undefined,
  unauthorizedAgent: AppEnv.APP_PROXY_ENABLED
    ? new HttpsProxyAgent(proxy, { rejectUnauthorized: false })
    : new https.Agent({ rejectUnauthorized: false }),
};

Logger.log(f`init with proxy ${{ enabled: AppEnv.APP_PROXY_ENABLED, proxy }}`, '[AppProxy]');
