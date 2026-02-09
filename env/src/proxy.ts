import { Logger } from '@nestjs/common';

import { f } from '@app/utils/logging';

import { SysEnv } from './configure';

const proxy = SysEnv.APP_PROXY_ENABLED ? `${SysEnv.APP_PROXY_HOST}:${SysEnv.APP_PROXY_PORT}` : '';
export const SysProxy = {
  proxy,
};

Logger.log(f`init with proxy ${{ enabled: SysEnv.APP_PROXY_ENABLED, proxy }}`, 'SysProxy');
