type WhereFilter<ItemModel> = OptionalQuery<ItemModel>;
type WhereFilterOp = "<" | "<=" | "==" | ">=" | ">" | "array-contains";
type OrderByDirection = "desc" | "asc";
type startEndAtTypes = string | number;

export interface SimpleQuery<ItemModel> {
  limit?: number;
  where?: WhereFilter<ItemModel>[];
  orderBy?: { pathObj: OptionalFlex<ItemModel>; dir?: OrderByDirection }[];
  startAt?: startEndAtTypes[];
  endAt?: startEndAtTypes[];
  _internalStartAfterDocId?: any; // Used for pagination. If defined then we ignore startAt
}

export type Optional<T> = { [P in keyof T]?: Optional2<T[P]> };
type Optional2<T> = { [P in keyof T]?: Optional3<T[P]> };
type Optional3<T> = { [P in keyof T]?: Optional4<T[P]> };
type Optional4<T> = { [P in keyof T]?: Optional5<T[P]> };
type Optional5<T> = { [P in keyof T]?: Optional6<T[P]> };
type Optional6<T> = { [P in keyof T]?: Optional7<T[P]> };
type Optional7<T> = { [P in keyof T]?: Optional8<T[P]> };
type Optional8<T> = { [P in keyof T]?: any };

export type OptionalQuery<T> = { [P in keyof T]?: [WhereFilterOp, T[P]] | OptionalQuery2<T[P]> };
type OptionalQuery2<T> = { [P in keyof T]?: [WhereFilterOp, T[P]] | OptionalQuery3<T[P]> };
type OptionalQuery3<T> = { [P in keyof T]?: [WhereFilterOp, T[P]] | OptionalQuery4<T[P]> };
type OptionalQuery4<T> = { [P in keyof T]?: [WhereFilterOp, T[P]] | OptionalQuery5<T[P]> };
type OptionalQuery5<T> = { [P in keyof T]?: [WhereFilterOp, T[P]] | OptionalQuery6<T[P]> };
type OptionalQuery6<T> = { [P in keyof T]?: [WhereFilterOp, T[P]] | OptionalQuery7<T[P]> };
type OptionalQuery7<T> = { [P in keyof T]?: [WhereFilterOp, T[P]] | OptionalQuery8<T[P]> };
type OptionalQuery8<T> = { [P in keyof T]?: any };

// Allows you to create an object that mirrors the shape of a interface but you can put a boolean at any node.
// The object can then be used to extract the path
export type OptionalFlex<T> = { [P in keyof T]?: boolean | OptionalFlex2<T[P]> };
type OptionalFlex2<T> = { [P in keyof T]?: boolean | OptionalFlex3<T[P]> };
type OptionalFlex3<T> = { [P in keyof T]?: boolean | OptionalFlex4<T[P]> };
type OptionalFlex4<T> = { [P in keyof T]?: boolean | OptionalFlex5<T[P]> };
type OptionalFlex5<T> = { [P in keyof T]?: boolean | OptionalFlex6<T[P]> };
type OptionalFlex6<T> = { [P in keyof T]?: boolean | OptionalFlex7<T[P]> };
type OptionalFlex7<T> = { [P in keyof T]?: boolean | OptionalFlex8<T[P]> };
type OptionalFlex8<T> = { [P in keyof T]?: any };

interface BatchTaskRoot {
  collection: string;
  id: string;
}

export const MagicDeleteString = "____DELETE_DELETE_DELETE_DELETE____";
export const MagicIncrementString = "____INCREMENT_INCREMENT_INCREMENT____";
export const MagicServerTimestampString = "____SEVRVERTIMESTAMP_SEVRVERTIMESTAMP_SEVRVERTIMESTAMP____";

export interface BatchTaskAdd extends BatchTaskRoot {
  type: "add";
  doc: any;
}

export interface BatchTaskEmpty extends BatchTaskRoot {
  type: "empty";
}

export interface BatchTaskSetPath extends BatchTaskRoot {
  type: "setPath";
  pathObj: any;
  value: any;
}

export interface BatchTaskUpdate extends BatchTaskRoot {
  type: "update";
  doc: any;
}

export interface BatchTaskDelete extends BatchTaskRoot {
  type: "delete";
}

export type BatchTask = BatchTaskAdd | BatchTaskSetPath | BatchTaskUpdate | BatchTaskDelete | BatchTaskEmpty;
