import { HttpsProxyAgent } from 'https-proxy-agent';
import { Logger } from '@nestjs/common';

import { SysEnv } from './configure';
import { f } from '@app/utils';
import https from 'node:https';

const proxy = SysEnv.APP_PROXY_ENABLED ? `${SysEnv.APP_PROXY_HOST}:${SysEnv.APP_PROXY_PORT}` : '';
export const SysProxy = {
  agent: SysEnv.APP_PROXY_ENABLED ? new HttpsProxyAgent(proxy) : undefined,
  unauthorizedAgent: SysEnv.APP_PROXY_ENABLED
    ? new HttpsProxyAgent(proxy, { rejectUnauthorized: false })
    : new https.Agent({ rejectUnauthorized: false }),
};

Logger.log(f`init with proxy ${{ enabled: SysEnv.APP_PROXY_ENABLED, proxy }}`, 'SysProxy');
