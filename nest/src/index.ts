import './exceptions/oops-factories'; // side-effect: attaches factory methods

// 核心组件导出
// 注意：为了避免加载顺序和依赖副作用，建议引用者直接引用具体子目录，
// 如 @app/nest/exceptions/any-exception.filter

export * from './common/interface';
export * from './common/response';
export * from './exceptions/business-exception.interface'; // @deprecated — use OopsError
export * from './exceptions/error-codes';
// OOPS_ERROR_METADATA_KEY already exported via error-codes above
export * from './exceptions/oops-error';
export * from './exceptions/oops';
