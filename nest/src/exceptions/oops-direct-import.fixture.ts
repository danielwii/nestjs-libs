import { Oops } from './oops';

const snapshot = {
  validation: Oops.Validation('invalid').oopsCode,
  notFound: Oops.Block.NotFound('Device', 'device-1').oopsCode,
  database: Oops.Panic.Database('query').oopsCode,
  externalService: Oops.Panic.ExternalService('redis').oopsCode,
  config: Oops.Panic.Config('missing key').oopsCode,
};

console.log(JSON.stringify(snapshot));
