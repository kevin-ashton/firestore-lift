import * as firebase from "firebase";
import { BatchTask, BatchTaskEmpty, MagicDeleteString, MagicIncrementString } from "./models";
import { generateFirestorePathFromObject } from "./misc";

export class BatchRunner {
  public firestore: typeof firebase.firestore;

  constructor(config: { firestore: typeof firebase.firestore }) {
    this.firestore = config.firestore;
  }

  // We use a magic string for deletes so we can pass around batches of change sets to be environment agnostic
  private checkForMagicStrings(obj: any) {
    if (typeof obj === "object") {
      let keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        let k = keys[i];
        if (obj[k] === MagicDeleteString) {
          obj[k] = this.firestore.FieldValue.delete();
        } else if (obj[k] === MagicIncrementString) {
          obj[k] = this.firestore.FieldValue.increment(1);
        } else if (typeof obj[k] === "object") {
          obj[k] = this.checkForMagicStrings(obj[k]);
        } else {
          obj[k] = obj[k];
        }
      }
    }
    if (typeof obj === "string" && obj === MagicDeleteString) {
      return this.firestore.FieldValue.delete();
    }
    return obj;
  }

  async executeBatch(b: BatchTask[]): Promise<BatchTaskEmpty> {
    let batch = this.firestore().batch();
    try {
      for (let i = 0; i < b.length; i++) {
        let task = b[i];
        if (task.type === "empty") {
          continue;
        }

        if (!task.id) {
          throw Error(`Unable to process item. Lacks an id. Collection: ${task.collection}. Task Type: ${task.type}`);
        }
        let ref = this.firestore()
          .collection(task.collection)
          .doc(task.id);

        let newObj;
        switch (task.type) {
          case "add":
            batch.set(ref, task.doc);
            break;
          case "setPath":
            let p = generateFirestorePathFromObject(task.pathObj);
            let newPathVal = p.path.split(".").reduce((acc, val) => {
              if (acc[val] === undefined) {
                throw new Error("Missing value for setPath update");
              }
              return acc[val];
            }, task.value);
            newPathVal = this.checkForMagicStrings(newPathVal);
            batch.update(ref, p.path, newPathVal);
            break;
          case "update":
            newObj = this.checkForMagicStrings(task.doc);
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
