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
  SimpleQuery,
  MagicDeleteString
} from "./models";
import { generatePushID, generateQueryRef } from "./misc";
import { BatchRunner } from "./BatchRunner";

type Change<T> = { item: T; changeType: "added" | "modified" | "removed" }[];

type SubFn<ItemModel> = (
  fn: (p: { items: ItemModel[]; changes: Change<ItemModel>[]; metadata: firebase.firestore.SnapshotMetadata }) => void
) => { unsubscribe: () => void };

export class FirestoreLift<ItemModel> {
  private readonly collection: string;
  private readonly firestoreInstance: firebase.firestore.Firestore;
  private readonly batchRunner: BatchRunner;
  private readonly yupSchema: Schema<any>;
  private firestoreSubId: number = 1;
  private firestoreSubscriptions: any = {};
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
    return Object.keys(this.firestoreSubscriptions).length;
  }

  public async querySubscription(query: SimpleQuery<ItemModel>): Promise<{ subscribe: SubFn<ItemModel> }> {
    let firestoreSubId = this.firestoreSubId;
    this.firestoreSubId += 1;

    let queryRef = await generateQueryRef(query, this.collection, this.firestoreInstance as any);

    let subFns = [];
    return {
      subscribe: (fn) => {
        console.log("Subscribe to query");

        subFns.push(fn);

        if (subFns.length === 1) {
          let unsubFirestore = queryRef.onSnapshot((snapshot) => {
            let docs = snapshot.docs.map((d) => d.data());
            let changes: Change<ItemModel> = [];

            snapshot.docChanges().forEach((change) => {
              changes.push({ item: change.doc.data() as any, changeType: change.type });
            });

            subFns.forEach((fn) => {
              fn({ items: docs, changes, metadata: snapshot.metadata });
            });
          });

          this.firestoreSubscriptions[firestoreSubId] = {
            unsubscribe: unsubFirestore,
            query
          };
        }

        return {
          unsubscribe: () => {
            subFns.splice(subFns.indexOf(fn), 1);
            if (subFns.length === 0 && this.firestoreSubscriptions[firestoreSubId]) {
              this.firestoreSubscriptions[firestoreSubId].unsubscribe();
              delete this.firestoreSubscriptions[firestoreSubId];
            }
          }
        };
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

  // Fetches a batch of documents based on ids
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
