import * as firebase from "firebase";
import { Schema } from "yup";
import {
  BatchTaskAdd,
  BatchTaskDelete,
  BatchTaskEmpty,
  BatchTaskUpdate,
  BatchTaskSetPath,
  Optional,
  OptionalFlex,
  SimpleQuery
} from "./models";
import { generatePushID, generateQueryRef } from "./misc";
import { BatchRunner } from "./BatchRunner";

type Change<T> = { item: T; changeType: "added" | "modified" | "removed" }[];

export type FirestoreLiftSubscription<ItemModel> = Promise<{
  subscribe: (
    fn: (p: { items: ItemModel[]; changes: Change<ItemModel>[]; metadata: firebase.firestore.SnapshotMetadata }) => void
  ) => {
    unsubscribe: () => void;
  };
}>;

export type UnpackFirestoreLiftSubscription<T> = T extends FirestoreLiftSubscription<infer U> ? U : T;

export class FirestoreLift<ItemModel> {
  private readonly collection: string;
  private readonly batchRunner: BatchRunner;
  private readonly yupSchema: Schema<any>;
  private firestoreSubId: number = 1;
  private firestoreSubscriptions: any = {};
  private readonly prefixIdWithCollection: boolean;
  private readonly addIdPropertyByDefault: boolean;
  private firestore: firebase.firestore.Firestore;

  constructor(config: {
    collection: string;

    batchRunner: BatchRunner;
    yupSchema?: Schema<any>;
    prefixIdWithCollection: boolean;
    addIdPropertyByDefault: boolean;
  }) {
    this.collection = config.collection;
    this.batchRunner = config.batchRunner;
    this.firestore = this.batchRunner.firestore();
    this.yupSchema = config.yupSchema;
    this.prefixIdWithCollection = config.prefixIdWithCollection;
    this.addIdPropertyByDefault = config.addIdPropertyByDefault;
  }

  public generateId() {
    return this.prefixIdWithCollection ? `${this.collection}-${generatePushID()}` : generatePushID();
  }

  public getSubscriptionCount(): number {
    return Object.keys(this.firestoreSubscriptions).length;
  }

  public async querySubscription(query: SimpleQuery<ItemModel>): FirestoreLiftSubscription<ItemModel> {
    let firestoreSubId = this.firestoreSubId;
    this.firestoreSubId += 1;

    let queryRef = await generateQueryRef(query, this.collection, this.firestore as any);

    return {
      subscribe: (fn, errorFn: (e: Error) => void = (e) => {}) => {
        let unsubFirestore = queryRef.onSnapshot(
          (snapshot) => {
            let docs = snapshot.docs.map((d) => d.data());
            let changes: Change<ItemModel> = [];

            snapshot.docChanges().forEach((change) => {
              changes.push({ item: change.doc.data() as any, changeType: change.type });
            });

            fn({ items: docs, changes, metadata: snapshot.metadata });
          },
          errorFn
        );

        this.firestoreSubscriptions[firestoreSubId] = {
          query
        };

        return {
          unsubscribe: () => {
              unsubFirestore();
              delete this.firestoreSubscriptions[firestoreSubId];
          }
        };
      }
    };
  }

  async query(
    queryRequest: SimpleQuery<ItemModel>
  ): Promise<{ items: ItemModel[]; nextQuery?: SimpleQuery<ItemModel> }> {
    let query = await generateQueryRef(queryRequest, this.collection, this.firestore as any);
    let results = [];
    let res = await query.get();
    for (let i = 0; i < res.docs.length; i++) {
      let doc = res.docs[i].data();
      await this.validateDoc(doc);
      results.push(doc);
    }

    let result: { items: ItemModel[]; nextQuery?: SimpleQuery<ItemModel> } = { items: results };
    if (res.size === queryRequest.limit) {
      let paginationQuery = { ...queryRequest };
      let lastDoc = res.docs[res.docs.length - 1];
      paginationQuery._internalStartAfterDocId = lastDoc.id;
      result.nextQuery = paginationQuery;
    }

    return result;
  }

  private async validateDoc(doc: any): Promise<boolean> {
    if (this.yupSchema) {
      try {
        await this.yupSchema.validate(doc);
      } catch (e) {
        console.warn(`Invalid schema detected. Collection: ${this.collection}. Id: ${doc.id}. Message: ${e.message}`);
        return false;
      }
    }
    return true;
  }

  // Fetches a batch of documents based on ids
  async get(ids: string[], options: { ignoreMissingIds: boolean } = { ignoreMissingIds: false }): Promise<ItemModel[]> {
    let p = [];
    let warnings = [];
    let docs: ItemModel[] = [];
    for (let i = 0; i < ids.length; i++) {
      p.push(
        (async () => {
          let res = await this.firestore
            .collection(this.collection)
            .doc(ids[i])
            .get();
          let doc = res.data();
          if (doc) {
            await this.validateDoc(doc);
            docs.push(doc as any);
          } else {
            warnings.push(ids[i]);
          }
        })()
      );
    }

    await Promise.all(p);

    // Sort for consistent return ordering
    docs = docs.sort((a, b) => {
      if (a["id"] > b["id"]) {
        return -1;
      } else {
        return 1;
      }
    });

    if (warnings.length > 0) {
      let msg = `Unable to find docs for the following ids ${JSON.stringify(warnings)}. Collection: ${this.collection}`;
      if (options.ignoreMissingIds) {
        console.warn(msg);
      } else {
        throw new Error(msg);
      }
    }

    return docs;
  }

  // Adds a document
  async add(
    request: { item: ItemModel },
    config?: { returnBatchTask: boolean }
  ): Promise<BatchTaskAdd | BatchTaskEmpty> {
    if (this.addIdPropertyByDefault && !request.item["id"]) {
      request.item["id"] = this.generateId();
    }

    if (!(await this.validateDoc(request.item))) {
      throw new Error(`Unable to add item. Schema does not match. Collection: ${this.collection}`);
    }

    let task: BatchTaskAdd = {
      id: request.item["id"],
      type: "add",
      collection: this.collection,
      doc: request.item
    };

    if (config && config.returnBatchTask) {
      return task;
    } else {
      return await this.batchRunner.executeBatch([task]);
    }
  }

  // Destructive update/delete for document path. Does not merge with existing data.
  async setPath(
    request: { id: string; pathObj: OptionalFlex<ItemModel>; value: Optional<ItemModel> },
    config?: { returnBatchTask: boolean }
  ): Promise<BatchTaskSetPath | BatchTaskEmpty> {
    let task: BatchTaskSetPath = {
      type: "setPath",
      id: request.id,
      pathObj: request.pathObj,
      value: request.value,
      collection: this.collection
    };
    if (config && config.returnBatchTask) {
      return task;
    } else {
      return await this.batchRunner.executeBatch([task]);
    }
  }

  // Updates/deletes parts of a document. Will merge with existing data.
  async update(
    request: { id: string; item: Optional<ItemModel> },
    config?: { returnBatchTask: boolean }
  ): Promise<BatchTaskUpdate | BatchTaskEmpty> {
    let task: BatchTaskUpdate = {
      type: "update",
      id: request.id,
      doc: request.item,
      collection: this.collection
    };
    if (config && config.returnBatchTask) {
      return task;
    } else {
      return await this.batchRunner.executeBatch([task]);
    }
  }

  // Deletes a document
  async delete(r: { id: string }, config?: { returnBatchTask: boolean }): Promise<BatchTaskDelete | BatchTaskEmpty> {
    let task: BatchTaskDelete = {
      type: "delete",
      collection: this.collection,
      id: r.id
    };
    if (config && config.returnBatchTask) {
      return task;
    } else {
      return await this.batchRunner.executeBatch([task]);
    }
  }
}
