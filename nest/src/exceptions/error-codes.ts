export enum ErrorCodes {
  // ==================== 0x01xx - 客户端可处理 ====================
  // 前端开发者关注：用户输入、界面交互、客户端验证问题
  CLIENT_INPUT_ERROR = '0x0101', // 输入格式错误
  CLIENT_VALIDATION_FAILED = '0x0102', // 客户端验证失败
  CLIENT_AUTH_REQUIRED = '0x0103', // 需要登录认证
  CLIENT_PERMISSION_DENIED = '0x0104', // 权限不足
  CLIENT_RATE_LIMITED = '0x0105', // 请求频率限制
  CLIENT_RESOURCE_CONFLICT = '0x0106', // 资源冲突（如重复操作）

  // ==================== 0x02xx - 业务规则 ====================
  // 产品/业务人员关注：业务逻辑、规则配置、流程设计问题
  BUSINESS_RULE_VIOLATION = '0x0201', // 违反业务规则
  BUSINESS_QUOTA_EXCEEDED = '0x0202', // 业务配额超限
  BUSINESS_OPERATION_FORBIDDEN = '0x0203', // 业务操作不被允许
  BUSINESS_DATA_CONFLICT = '0x0204', // 业务数据冲突
  BUSINESS_WORKFLOW_ERROR = '0x0205', // 业务流程错误

  // ==================== 0x03xx - 外部依赖 ====================
  // 运维/DevOps关注：外部服务、API密钥、网络连接问题
  EXTERNAL_API_AUTH_FAILED = '0x0301', // 外部API认证失败
  EXTERNAL_API_UNAVAILABLE = '0x0302', // 外部服务不可用
  EXTERNAL_API_TIMEOUT = '0x0303', // 外部API超时
  EXTERNAL_API_QUOTA = '0x0304', // 外部API配额限制
  EXTERNAL_SERVICE_ERROR = '0x0305', // 外部服务错误

  // ==================== 0x04xx - 系统问题 ====================
  // 后端开发者关注：代码bug、系统配置、资源问题
  SYSTEM_DATABASE_ERROR = '0x0401', // 数据库错误
  SYSTEM_CONFIG_ERROR = '0x0402', // 系统配置错误
  SYSTEM_LOGIC_ERROR = '0x0403', // 代码逻辑错误
  SYSTEM_RESOURCE_EXHAUSTED = '0x0404', // 系统资源不足
  SYSTEM_INTERNAL_ERROR = '0x0405', // 未分类的内部错误

  // ==================== 0x05xx - 数据问题 ====================
  // 数据管理员/运维关注：数据完整性、迁移、修复问题
  DATA_CORRUPTION = '0x0501', // 数据损坏
  DATA_CONSISTENCY_ERROR = '0x0502', // 数据一致性错误
  DATA_MIGRATION_NEEDED = '0x0503', // 需要数据迁移
  DATA_VERSION_MISMATCH = '0x0504', // 数据版本不匹配
}

export type ErrorCodeValue = `${ErrorCodes}`;
