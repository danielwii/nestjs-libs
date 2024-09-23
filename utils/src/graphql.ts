import { Field, ID, InputType, Int, InterfaceType, ObjectType } from '@nestjs/graphql';
import { plainToInstance } from 'class-transformer';

// import type { RequestInfo } from '../app/auth/types';
// import type * as DBTypes from '@prisma/client';
//
// export type GraphqlContext = {
//   req: RequestInfo<DBTypes.users | DBTypes.user_v2>;
// } & {
//   // getDataLoaders: () => RegisteredLoaders;
//   getCurrentUser: () => DBTypes.users | DBTypes.user_v2 | undefined;
//   // getPayload: () => PayloadType;
//   // getTrace: () => SpanContext;
// };

export interface CursoredRequest {
  first: number;
  after?: string | number;
}

@InputType()
export class CursoredRequestInput implements CursoredRequest {
  @Field(() => Int, { description: 'page size', nullable: true, defaultValue: 20 })
  first: number = 20;

  @Field(() => ID, { description: 'latest cursor', nullable: true })
  after?: string | number;

  static DEFAULT = { first: 20 };
}

@ObjectType()
export class CursorInfo {
  @Field((returns) => ID, { nullable: true })
  endCursor?: string | number;

  @Field()
  hasNextPage!: boolean;

  public static of(o?: CursorInfo): CursorInfo {
    return plainToInstance(CursorInfo, o);
  }
}

@InterfaceType()
export class CursoredPageable<T> {
  @Field((returns) => Int) total!: number;
  @Field((returns) => CursorInfo) cursorInfo!: CursorInfo;

  items: T[] = [];
}

export const CursoredResponse = <Item>(ItemClass: Item) => {
  // `isAbstract` decorator option is mandatory to prevent registering in schema
  @ObjectType({ isAbstract: true, implements: () => [CursoredPageable] })
  abstract class CursoredResponseClass extends CursoredPageable<Item> {
    // here we use the runtime argument
    @Field(() => [ItemClass] as Array<Item>)
    // and here the generic type
    declare items: Item[];
  }
  return CursoredResponseClass;
};
