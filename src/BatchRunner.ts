import * as firebase from "firebase";
import { BatchTask, BatchTaskEmpty, MagicDeleteString } from "./models";

export class BatchRunner {
  private firestoreInstance: firebase.firestore.Firestore;

  // Depending on the SDK passed into the BatchRunner (admin-tools vs firebase) this can be a bit different
  private firestoreModule: any;

  constructor(config: { fireStoreInstance: firebase.firestore.Firestore; firestoreModule: any }) {
    this.firestoreInstance = config.fireStoreInstance;
    this.firestoreModule = config.firestoreModule;
  }

  // We use a magic string for deletes so we can pass around batches of change sets to be environment agnostic
  private checkForMagicDeleteString(obj: any) {
    if (typeof obj === "object") {
      let keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        let k = keys[i];
        if (obj[k] === MagicDeleteString) {
          obj[k] = this.firestoreModule.FieldValue.delete();
        } else if (typeof obj[k] === "object") {
          obj[k] = this.checkForMagicDeleteString(obj[k]);
        } else {
          obj[k] = obj[k];
        }
      }
    }
    return obj;
  }

  async executeBatch(b: BatchTask[]): Promise<BatchTaskEmpty> {
    let batch = this.firestoreInstance.batch();
    try {
      for (let i = 0; i < b.length; i++) {
        let task = b[i];
        if (task.type === "empty") {
          continue;
        }

        if (!task.id) {
          throw Error(`Unable to process item. Lacks an id. Collection: ${task.collection}. Task Type: ${task.type}`);
        }
        let ref = this.firestoreInstance.collection(task.collection).doc(task.id);

        let newObj;
        switch (task.type) {
          case "add":
            batch.set(ref, task.doc);
            break;
          case "shallowUpdate":
            newObj = this.checkForMagicDeleteString(task.doc);
            batch.update(ref, newObj);
            break;
          case "update":
            newObj = this.checkForMagicDeleteString(task.doc);
            batch.set(ref, newObj, { merge: true });
            break;
          case "delete":
            batch.delete(ref);
            break;
        }
      }

      await batch.commit();

      // Returning an empty task makes it easier for the helper functions (.add, .update) so they always return a batch type. Makes it so we don't have to check for undefined
      return {
        id: "",
        collection: "empty",
        type: "empty"
      };
    } catch (e) {
      console.error("Trouble executing batch");
      console.error(e);
      throw e;
    }
  }
}
