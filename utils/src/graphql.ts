import { Field, ID, InputType, Int, InterfaceType, ObjectType } from '@nestjs/graphql';

import { plainToInstance } from 'class-transformer';
import { Allow } from 'class-validator';

// import type { RequestInfo } from '../app/auth/types';
// import type * as DBTypes from '@/generated/prisma/client';
//
// export type GraphqlContext = {
//   req: RequestInfo<DBTypes.users | DBTypes.user_v2>;
// } & {
//   // getDataLoaders: () => RegisteredLoaders;
//   getCurrentUser: () => DBTypes.users | DBTypes.user_v2 | undefined;
//   // getPayload: () => PayloadType;
//   // getTrace: () => SpanContext;
// };

/**
 * 游标分页请求输入
 *
 * 设计意图：提供标准的游标分页请求参数
 * 业务场景：适用于所有需要分页的列表查询
 * 默认行为：每页 20 条记录
 */
export interface CursoredRequest {
  first: number;
  after?: string | number;
}

@InputType({
  description: '标准游标分页输入：first 控制每页数量，after 指定起始游标。可直接复用或在业务输入上继承扩展。',
})
export class CursoredRequestInput implements CursoredRequest {
  @Field(() => Int, { description: 'page size', nullable: true, defaultValue: 20 })
  @Allow()
  first: number = 20;

  @Field(() => ID, { description: 'latest cursor', nullable: true })
  @Allow()
  after?: string | number;

  static DEFAULT = { first: 20 };
}

/**
 * 游标/页码分页公共信息
 *
 * 设计意图：抽象分页模式的公共字段，避免滥用可选属性
 */
@InterfaceType({
  resolveType(value: PaginationInfo): string | undefined {
    if (value && typeof value === 'object' && 'currentPage' in value) {
      return 'PagePaginationInfo';
    }
    return 'CursorPaginationInfo';
  },
})
export abstract class PaginationInfo {
  @Field(() => Boolean, { description: '是否有下一页' })
  hasNextPage!: boolean;

  @Field(() => Boolean, { description: '是否有上一页' })
  hasPreviousPage!: boolean;
}

/**
 * 游标分页信息
 *
 * 设计意图：提供前端计算下一页所需的游标数据
 */
@ObjectType({ implements: () => [PaginationInfo] })
export class CursorPaginationInfo extends PaginationInfo {
  @Field(() => ID, { nullable: true, description: '当前页最后一条记录的游标' })
  endCursor: string | number | null = null;

  @Field(() => ID, { nullable: true, description: '当前页第一条记录的游标' })
  startCursor: string | number | null = null;

  public static fromState(state: CursorPaginationState): CursorPaginationInfo {
    return plainToInstance(CursorPaginationInfo, state);
  }
}

/**
 * 页码式分页信息
 *
 * 设计意图：配合 page/pageSize 进行传统分页展示
 */
@ObjectType({ implements: () => [PaginationInfo] })
export class PagePaginationInfo extends PaginationInfo {
  @Field(() => Int, { nullable: true, description: '总页数（基于当前 pageSize 计算）' })
  totalPages?: number;

  @Field(() => Int, { description: '当前页码（从 1 开始）' })
  currentPage!: number;

  public static fromState(state: PagePaginationState): PagePaginationInfo {
    return plainToInstance(PagePaginationInfo, state);
  }
}

export interface CursorPaginationState {
  endCursor: string | number | null;
  startCursor: string | number | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PagePaginationState {
  currentPage: number;
  totalPages?: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * 游标分页响应接口
 *
 * 设计意图：定义统一的分页响应结构
 * 解决问题：标准化不同资源的分页响应格式
 * 泛型支持：T 为具体的资源类型
 */
@InterfaceType()
export abstract class CursorPageable<T> {
  @Field(() => Int, { description: '满足游标分页场景的记录总数（仅在首批请求时计算）' })
  total!: number;

  @Field(() => CursorPaginationInfo, {
    description: '游标分页信息，仅在游标模式下暴露 startCursor/endCursor 等字段',
  })
  cursorInfo!: CursorPaginationInfo;

  items: T[] = [];
}

/**
 * 游标分页响应工厂函数
 *
 * 设计意图：动态生成类型安全的分页响应类
 * 解决问题：避免为每种资源类型重复定义分页响应类
 * 使用示例：
 * @example
 * @ObjectType()
 * class UserPagedResponse extends CursoredResponse(UserType) {}
 *
 * Business reason: 泛型参数 Item 表示实例类型，ItemClass 是构造函数类型
 * 这样确保 items 数组包含的是类实例而不是类构造函数
 */
export const CursoredResponse = <Item>(ItemClass: new () => Item) => {
  // `isAbstract` decorator option is mandatory to prevent registering in schema
  @ObjectType({ isAbstract: true, implements: () => [CursorPageable] })
  abstract class CursoredResponseClass extends CursorPageable<Item> {
    // here we use the runtime argument (ItemClass 是构造函数)
    @Field(() => [ItemClass] as unknown as Array<Item>)
    // and here the generic type (Item 是实例类型)
    declare items: Item[];
  }
  return CursoredResponseClass;
};

/**
 * 复合游标编码/解码工具
 *
 * 设计意图：使用时间戳+ID 组合作为游标，解决无序 ID 问题
 * 格式：base64(resourceType:timestamp:id)
 *
 * @example
 * const cursor = encodeCursor('userPhoto', new Date('2024-01-01'), 'uuid-123')
 * // => 'dXNlclBob3RvOjE3MDQwNjcyMDAwMDA6dXVpZC0xMjM='
 */
export class CursorUtils {
  /**
   * 编码游标
   *
   * @param resourceType - 资源类型标识（如 'userPhoto', 'garmentPhoto'）
   * @param timestamp - 排序时间戳（通常是 createdAt）
   * @param id - 记录的唯一 ID
   * @returns Base64 编码的游标字符串
   */
  static encodeCursor(resourceType: string, timestamp: Date | string, id: string): string {
    // 转换时间戳为毫秒值，支持字符串和 Date 对象输入
    const timestampMs = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp.getTime();

    // 组合游标字符串：类型:时间戳:ID
    const cursorString = `${resourceType}:${timestampMs}:${id}`;

    // Base64 编码以防止 URL 特殊字符问题
    return Buffer.from(cursorString).toString('base64');
  }

  /**
   * 解码游标
   *
   * @param cursor - Base64 编码的游标
   * @returns 解码后的游标组件
   * @throws 如果游标格式无效
   */
  static decodeCursor(cursor: string): {
    resourceType: string;
    timestamp: Date;
    id: string;
  } {
    try {
      // Base64 解码
      const decoded = Buffer.from(cursor, 'base64').toString('utf-8');

      // 解析游标组件
      const [resourceType, timestampMs, id] = decoded.split(':');

      // 验证所有组件都存在
      if (!resourceType || !timestampMs || !id) {
        throw new Error('Invalid cursor format');
      }

      return {
        resourceType,
        timestamp: new Date(parseInt(timestampMs, 10)),
        id,
      };
    } catch (_error) {
      // 包装错误信息，便于调试
      throw new Error(`Invalid cursor: ${cursor}`);
    }
  }

  /**
   * 构建 Prisma 查询条件（用于时间戳+ID 复合排序）
   *
   * 设计意图：生成正确的 WHERE 条件以实现基于复合游标的分页
   * 算法：(timestamp < cursor_timestamp) OR (timestamp = cursor_timestamp AND id < cursor_id)
   *
   * @param cursor - 解码后的游标
   * @param direction - 分页方向（'forward' 或 'backward'）
   * @returns Prisma WHERE 条件对象
   */
  static buildCursorCondition(cursor: { timestamp: Date; id: string }, direction: 'forward' | 'backward' = 'forward') {
    const { timestamp, id } = cursor;

    if (direction === 'forward') {
      // 向后翻页：获取游标之后的记录
      return {
        OR: [
          { createdAt: { lt: timestamp } },
          {
            createdAt: timestamp,
            id: { lt: id },
          },
        ],
      };
    } else {
      // 向前翻页：获取游标之前的记录
      return {
        OR: [
          { createdAt: { gt: timestamp } },
          {
            createdAt: timestamp,
            id: { gt: id },
          },
        ],
      };
    }
  }

  /**
   * 计算分页信息
   *
   * @param totalCount - 总记录数
   * @param pageSize - 每页大小
   * @param currentItems - 当前页项目数
   * @param hasMore - 是否有更多记录
   * @returns 包含总页数和当前页的分页信息
   */
  /**
   * 计算分页信息
   *
   * @param totalCount - 总记录数
   * @param pageSize - 每页大小
   * @param currentItems - 当前页项目数 [待确认：未使用]
   * @param hasMore - 是否有更多记录 [待确认：未使用]
   * @returns 包含总页数和当前页的分页信息
   *
   * TODO: [功能完善] 实现当前页码计算
   *   问题：纯游标分页难以确定当前页码
   *   方案：需要记录已遍历的记录数或使用混合分页
   *   优先级：P2 - 前端分页器需要此信息
   */
  static calculatePageInfo(
    totalCount: number,
    pageSize: number,
    _currentItems: number,
    _hasMore: boolean,
  ): { totalPages: number; currentPage?: number } {
    const totalPages = Math.ceil(totalCount / pageSize);

    // 当前页码计算需要额外的偏移量信息
    // 在纯游标分页中，当前页码概念相对模糊

    return {
      totalPages,
      currentPage: undefined, // 需要根据具体实现计算
    };
  }
}
