export enum ErrorCodes {
  BadRequest = '0x0002',
  ZodError = '0x0003',
  NotFound = '0x0004',
  TooManyRequests = '0x0005',

  Unauthorized = '0x0101',
  AuthFailed = '0x0102',
  Conflict = '0x0109', // 数据冲突

  PrismaClientKnownRequestError = '0x0A0A', // prisma client 发生了已知的错误，通常是因为违反了数据库的约束
  FetchError = '0x0A0B', // 访问第三方 api 时发生了错误

  Outdated = '0x0B00', // 服务端的数据被更新，用户需要进行 reload 再进行下一步
  Unexpected = '0x0B10', // 服务端的数据异常，并不是期望的数据，需要人工介入

  Undefined = '0x0C00', // 未明确定义的 422 错误，通常只有 message，没有更具体的信息，需要综合 trace id 和 message 来定位问题
}
