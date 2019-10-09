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
  startEndAtTypes
} from "./models";
import { generatePushID, generateQueryRef } from "./misc";
import { BatchRunner } from "./BatchRunner";
import * as md5 from "md5";

type Change<T> = { item: T; changeType: "added" | "modified" | "removed" }[];

export type SubscriptionResultSet<ItemModel> = {
  items: ItemModel[];
  rawDocItems: (firebase.firestore.DocumentSnapshot | firebase.firestore.QueryDocumentSnapshot)[];
  changes: Change<ItemModel>[];
  metadata: firebase.firestore.SnapshotMetadata;
};

export type QueryResultSet<ItemModel> = {
  items: ItemModel[];
  rawDocItems: (firebase.firestore.DocumentSnapshot | firebase.firestore.QueryDocumentSnapshot)[];
  nextQuery?: SimpleQuery<ItemModel>;
};

export type FirestoreLiftSubscription<ItemModel> = {
  subscribe: (
    fn: (p: SubscriptionResultSet<ItemModel>) => void,
    errorFn?: (e: Error) => void
  ) => {
    unsubscribe: () => void;
  };
};

export type UnpackFirestoreLiftSubscription<T> = T extends FirestoreLiftSubscription<infer U> ? U : T;

interface ActiveSubscriptions {
  [subscriptionId: string]: {
    subscriptionDetails: string;
    subscriberCount: number;
  };
}

export interface FirestoreLiftStats {
  statsInitMS: number;
  docsFetched: number;
  docsWritten: number; // Assumes the tasks were executed
  totalSubscriptionsOverTime: number;
  activeSubscriptions: ActiveSubscriptions;
}

export class FirestoreLift<ItemModel> {
  private readonly collection: string;
  private readonly batchRunner: BatchRunner;
  private readonly yupSchema: Schema<any>;
  public _stats: FirestoreLiftStats = {
    statsInitMS: Date.now(),
    docsFetched: 0,
    docsWritten: 0,
    activeSubscriptions: {},
    totalSubscriptionsOverTime: 0
  };
  private firestoreSubscriptionIdCounter: number = 1;
  private firestoreSubscriptions: {
    [subscriptionId: string]: {
      subscriptionDetails: any;
      fns: { [subId: string]: any };
      errorFns: { [subId: string]: any };
      firestoreUnsubscribeFn: any;
      currentValue?: any;
    };
  } = {};
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
    this.firestore = this.batchRunner.firestore(this.batchRunner.app);
    this.yupSchema = config.yupSchema;
    this.prefixIdWithCollection = config.prefixIdWithCollection;
    this.addIdPropertyByDefault = config.addIdPropertyByDefault;
  }

  public generateId() {
    return this.prefixIdWithCollection ? `${this.collection}-${generatePushID()}` : generatePushID();
  }

  private registerSubscription(p: { uniqueSubscriptionId: number; subscriptionId: string; fn: any; errorFn?: any }) {
    if (!this.firestoreSubscriptions[p.subscriptionId]) {
      throw Error("Cannot register a subscription until it has been setup");
    }

    this.firestoreSubscriptions[p.subscriptionId].fns[p.uniqueSubscriptionId] = p.fn;
    if (p.errorFn) {
      this.firestoreSubscriptions[p.subscriptionId].errorFns[p.uniqueSubscriptionId] = p.errorFn;
    }
  }
  private unregisterSubscription(p: { uniqueSubscriptionId: number; subscriptionId: string }) {
    if (!this.firestoreSubscriptions[p.subscriptionId]) {
      console.warn("Unable to unregister a subscription if it does not exist");
      return;
    }

    delete this.firestoreSubscriptions[p.subscriptionId].fns[p.uniqueSubscriptionId];
    delete this.firestoreSubscriptions[p.subscriptionId].errorFns[p.uniqueSubscriptionId];

    if (Object.keys(this.firestoreSubscriptions[p.subscriptionId].fns).length <= 0) {
      this.firestoreSubscriptions[p.subscriptionId].firestoreUnsubscribeFn();
      delete this.firestoreSubscriptions[p.subscriptionId];
    }
  }

  private updateSubscriptionStats() {
    let activeSubscriptions: ActiveSubscriptions = {};

    for (let subscriptionId in this.firestoreSubscriptions) {
      activeSubscriptions[subscriptionId] = {
        subscriptionDetails: this.firestoreSubscriptions[subscriptionId].subscriptionDetails,
        subscriberCount: Object.keys(this.firestoreSubscriptions[subscriptionId].fns).length
      };
    }

    this._stats.activeSubscriptions = activeSubscriptions;
  }

  public docSubscription(p: { docId: string }): FirestoreLiftSubscription<ItemModel> {
    let subscriptionId = md5(p.docId);
    let docRef = this.firestore.collection(this.collection).doc(p.docId);

    return {
      subscribe: (fn, errorFn?: (e: Error) => void) => {
        let uniqueSubscriptionId = this.firestoreSubscriptionIdCounter;
        this.firestoreSubscriptionIdCounter += 1;
        if (!this.firestoreSubscriptions[subscriptionId]) {
          let unsubFirestore = docRef.onSnapshot(
            (snapshot) => {
              let docs: any = [snapshot.data()];

              this._stats.docsFetched += 1;

              let value: SubscriptionResultSet<ItemModel> = {
                items: docs,
                rawDocItems: [snapshot],
                changes: [],
                metadata: snapshot.metadata
              };

              this.firestoreSubscriptions[subscriptionId].currentValue = value;
              for (let i in this.firestoreSubscriptions[subscriptionId].fns) {
                this.firestoreSubscriptions[subscriptionId].fns[i](value);
              }
            },
            (err) => {
              let msg = `${err.message} in firestore-lift subscription on collection ${this.collection} with docId:${p.docId}`;
              let detailedError = new Error(msg);
              if (Object.keys(this.firestoreSubscriptions[subscriptionId].errorFns).length > 0) {
                for (let i in this.firestoreSubscriptions[subscriptionId].errorFns) {
                  this.firestoreSubscriptions[subscriptionId].errorFns[i](detailedError);
                }
              } else {
                console.error(detailedError);
              }
            }
          );
          this.firestoreSubscriptions[subscriptionId] = {
            fns: {},
            errorFns: {},
            firestoreUnsubscribeFn: unsubFirestore,
            subscriptionDetails: p
          };
          this.registerSubscription({ fn, errorFn, subscriptionId: subscriptionId, uniqueSubscriptionId });
          this._stats.totalSubscriptionsOverTime += 1;
        } else {
          if (this.firestoreSubscriptions[subscriptionId].currentValue) {
            // First time function gets a copy of the current value
            fn(this.firestoreSubscriptions[subscriptionId].currentValue);
          }
          this.registerSubscription({ fn, errorFn, subscriptionId: subscriptionId, uniqueSubscriptionId });
        }
        this.updateSubscriptionStats();

        return {
          unsubscribe: () => {
            this.unregisterSubscription({ subscriptionId: subscriptionId, uniqueSubscriptionId });
            this.updateSubscriptionStats();
          }
        };
      }
    };
  }

  public querySubscription(query: SimpleQuery<ItemModel>): FirestoreLiftSubscription<ItemModel> {
    let subscriptionId = md5(stringifyQuery(query));
    let queryRef = generateQueryRef(query, this.collection, this.firestore as any);

    return {
      subscribe: (fn, errorFn?: (e: Error) => void) => {
        let uniqueSubscriptionId = this.firestoreSubscriptionIdCounter;
        this.firestoreSubscriptionIdCounter += 1;
        if (!this.firestoreSubscriptions[subscriptionId]) {
          let unsubFirestore = queryRef.onSnapshot(
            (snapshot) => {
              let docs: any = snapshot.docs.map((d) => d.data());
              let changes: Change<ItemModel> = [];

              this._stats.docsFetched += snapshot.docChanges().length;
              snapshot.docChanges().forEach((change) => {
                changes.push({ item: change.doc.data() as any, changeType: change.type });
              });

              let value: SubscriptionResultSet<ItemModel> = {
                items: docs,
                rawDocItems: snapshot.docs,
                changes: changes as any,
                metadata: snapshot.metadata
              };
              this.firestoreSubscriptions[subscriptionId].currentValue = value;
              for (let i in this.firestoreSubscriptions[subscriptionId].fns) {
                this.firestoreSubscriptions[subscriptionId].fns[i](value);
              }
            },
            (err) => {
              const queryObj = stringifyQuery(query);
              let msg = `${err.message} in firestore-lift subscription on collection ${this.collection} with query:${queryObj}`;
              let detailedError = new Error(msg);
              if (Object.keys(this.firestoreSubscriptions[subscriptionId].errorFns).length > 0) {
                for (let i in this.firestoreSubscriptions[subscriptionId].errorFns) {
                  this.firestoreSubscriptions[subscriptionId].errorFns[i](detailedError);
                }
              } else {
                console.error(detailedError);
              }
            }
          );
          this.firestoreSubscriptions[subscriptionId] = {
            fns: {},
            errorFns: {},
            firestoreUnsubscribeFn: unsubFirestore,
            subscriptionDetails: query
          };
          this.registerSubscription({ fn, errorFn, subscriptionId, uniqueSubscriptionId });
          this._stats.totalSubscriptionsOverTime += 1;
        } else {
          if (this.firestoreSubscriptions[subscriptionId].currentValue) {
            // First time function gets a copy of the current value
            fn(this.firestoreSubscriptions[subscriptionId].currentValue);
          }
          this.registerSubscription({ fn, errorFn, subscriptionId, uniqueSubscriptionId });
        }
        this.updateSubscriptionStats();

        return {
          unsubscribe: () => {
            this.unregisterSubscription({ subscriptionId, uniqueSubscriptionId });
            this.updateSubscriptionStats();
          }
        };
      }
    };
  }

  async query(queryRequest: SimpleQuery<ItemModel>): Promise<QueryResultSet<ItemModel>> {
    let query = generateQueryRef(queryRequest, this.collection, this.firestore as any);
    if (queryRequest._internalStartAfterDocId) {
      // Find start doc. This is used for pagination
      let startAfterDoc = await this.firestore
        .collection(this.collection)
        .doc(queryRequest._internalStartAfterDocId)
        .get();
      query = query.startAfter(startAfterDoc) as any;
    }
    let results = [];
    let res = await query.get();
    for (let i = 0; i < res.docs.length; i++) {
      let doc = res.docs[i].data();
      await this.validateDoc(doc);
      results.push(doc);
    }

    let result: QueryResultSet<ItemModel> = { items: results, rawDocItems: res.docs };

    if (res.size === queryRequest.limit) {
      let paginationQuery = { ...queryRequest };
      let lastDoc = res.docs[res.docs.length - 1];
      paginationQuery._internalStartAfterDocId = lastDoc.id;
      result.nextQuery = paginationQuery;
    }

    this._stats.docsFetched += result.items.length;
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

    this._stats.docsFetched += docs.length;
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

    this._stats.docsWritten += 1;
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
    this._stats.docsWritten += 1;
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
    this._stats.docsWritten += 1;
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
    this._stats.docsWritten += 1;
    if (config && config.returnBatchTask) {
      return task;
    } else {
      return await this.batchRunner.executeBatch([task]);
    }
  }
}

function stringifyQuery<ItemModel>(query: SimpleQuery<ItemModel>) {
  function scrub(a: startEndAtTypes) {
    if (typeof a !== "string" && typeof a !== "number") {
      return a.id;
    }
    return a;
  }

  const scrubbedQuery = JSON.stringify({
    ...query,
    endAt: query.endAt ? query.endAt.map(scrub) : undefined,
    endBefore: query.endBefore ? query.endBefore.map(scrub) : undefined,
    startAt: query.startAt ? query.startAt.map(scrub) : undefined,
    startAfter: query.startAfter ? query.startAfter.map(scrub) : undefined
  });

  return JSON.stringify(scrubbedQuery, null, 2);
}
