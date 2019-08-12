import * as firebase from "firebase";
import { Schema } from "yup";
import {
  BatchTaskAdd,
  BatchTaskDelete,
  BatchTaskEmpty,
  BatchTaskShallowUpdate,
  BatchTaskUpdate,
  Optional,
  SimpleQuery,
  MagicDeleteString
} from "./models";
import { generatePushID, generateQueryRef } from "./misc";
import { BatchRunner } from "./BatchRunner";

type SubFn<ItemModel> = (fn: (p: { ids: string[]; entities: { [key: string]: ItemModel } }) => void) => void;

export class FirestoreLift<ItemModel> {
  private readonly collection: string;
  private readonly firestoreInstance: firebase.firestore.Firestore;
  private readonly batchRunner: BatchRunner;
  private readonly yupSchema: Schema<any>;
  private subCount: number = 1;
  private querySubscriptions: any = {};
  private readonly prefixIdWithCollection: boolean;
  private readonly addIdPropertyByDefault: boolean;

  constructor(config: {
    collection: string;
    fireStoreInstance: firebase.firestore.Firestore;
    batchRunner: BatchRunner;
    yupSchema?: Schema<any>;
    prefixIdWithCollection: boolean;
    addIdPropertyByDefault: boolean;
  }) {
    this.collection = config.collection;
    this.firestoreInstance = config.fireStoreInstance;
    this.batchRunner = config.batchRunner;
    this.yupSchema = config.yupSchema;
    this.prefixIdWithCollection = config.prefixIdWithCollection;
    this.addIdPropertyByDefault = config.addIdPropertyByDefault;
  }

  public generateId() {
    return this.prefixIdWithCollection ? `${this.collection}-${generatePushID()}` : generatePushID();
  }

  // During an update put this in a field to signal it should be updated
  // We use a magic string for deletes so we can pass around batches of change sets to be environment agnostic. The actual delete function is added from the firestore later when a batch is executed.
  public getDeleteMagicValue(): any {
    return MagicDeleteString;
  }

  public getSubscriptionCount(): number {
    return Object.keys(this.querySubscriptions).length;
  }

  public async querySubscriptionEntities(p: {
    queryRequest: SimpleQuery<ItemModel>;
  }): Promise<{
    subscribe: SubFn<ItemModel>;
    unsubscribe: () => void;
  }> {
    let entities: any = {};
    let ids: string[] = [];
    let subId = this.subCount;
    this.subCount += 1;

    let query = await generateQueryRef(p.queryRequest, this.collection, this.firestoreInstance as any);
    let subRunning = false;

    let sbFns = [];

    let subFn: SubFn<ItemModel> = (fn) => {
      sbFns.push(fn);

      if (!subRunning) {
        let unsubRef = query.onSnapshot((snapshot) => {
          snapshot.docChanges().forEach((change) => {
            switch (change.type) {
              case "added":
                ids.push(change.doc.id);
                entities[change.doc.id] = change.doc.data();
                break;
              case "modified":
                entities[change.doc.id] = change.doc.data();
                break;
              case "removed":
                ids = ids.filter((i) => i !== change.doc.id);
                delete entities[change.doc.id];
                break;
            }

            for (let i = 0; i < sbFns.length; i++) {
              sbFns[i]({ entities, ids });
            }
          });
        });

        this.querySubscriptions[subId] = unsubRef;
      }
    };

    return {
      subscribe: subFn,
      unsubscribe: () => {
        console.log("Unsubscribe query entities");
        sbFns = [];
        if (this.querySubscriptions[subId]) {
          this.querySubscriptions[subId]();
          delete this.querySubscriptions[subId];
        }
      }
    };
  }

  public async querySubscription(p: {
    queryRequest: SimpleQuery<ItemModel>;
    cb: (p: { item: ItemModel; firestoreId: string; changeType: "added" | "modified" | "removed" }) => void;
  }): Promise<{ unsubscribe: () => void }> {
    let query = await generateQueryRef(p.queryRequest, this.collection, this.firestoreInstance as any);

    let unsubRef = query.onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        p.cb({ item: change.doc.data() as any, changeType: change.type, firestoreId: change.doc.id });
      });
    });

    let subId = this.subCount;
    this.subCount += 1;

    this.querySubscriptions[subId] = unsubRef;

    return {
      unsubscribe: () => {
        console.log("Unsubscribe query");
        this.querySubscriptions[subId]();
        delete this.querySubscriptions[subId];
      }
    };
  }

  async query(
    queryRequest: SimpleQuery<ItemModel>
  ): Promise<{ items: ItemModel[]; nextQuery?: SimpleQuery<ItemModel> }> {
    let query = await generateQueryRef(queryRequest, this.collection, this.firestoreInstance as any);
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

  async get(ids: string[], options: { ignoreMissingIds: boolean } = { ignoreMissingIds: false }): Promise<ItemModel[]> {
    let p = [];
    let warnings = [];
    let docs: ItemModel[] = [];
    for (let i = 0; i < ids.length; i++) {
      p.push(
        (async () => {
          let res = await this.firestoreInstance
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

  async shallowUpdate(
    request: { id: string; item: Optional<ItemModel> },
    config?: { returnBatchTask: boolean }
  ): Promise<BatchTaskShallowUpdate | BatchTaskEmpty> {
    let task: BatchTaskShallowUpdate = {
      type: "shallowUpdate",
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
