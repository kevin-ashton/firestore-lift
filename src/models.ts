type WhereFilter<ItemModel> = [string, WhereFilterOp, string | number | boolean] | [Optional<ItemModel>, WhereFilterOp];
type WhereFilterOp = "<" | "<=" | "==" | ">=" | ">" | "array-contains";
type OrderByDirection = "desc" | "asc";
type startEndAtTypes = string | number;

export interface SimpleQuery<ItemModel> {
  limit?: number;
  where?: WhereFilter<ItemModel>[];
  orderBy?: { path: string | Optional<ItemModel>; dir?: OrderByDirection }[];
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

interface BatchTaskRoot {
  collection: string;
  id: string;
}

export const MagicDeleteString = "____DELETE_DELETE_DELETE____";

export interface BatchTaskAdd extends BatchTaskRoot {
  type: "add";
  doc: any;
}

export interface BatchTaskEmpty extends BatchTaskRoot {
  type: "empty";
}

export interface BatchTaskShallowUpdate extends BatchTaskRoot {
  type: "shallowUpdate";
  doc: any;
}

export interface BatchTaskUpdate extends BatchTaskRoot {
  type: "update";
  doc: any;
}

export interface BatchTaskDelete extends BatchTaskRoot {
  type: "delete";
}

export type BatchTask = BatchTaskAdd | BatchTaskShallowUpdate | BatchTaskUpdate | BatchTaskDelete | BatchTaskEmpty;
