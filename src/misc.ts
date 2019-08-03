import { SimpleQuery } from "./models";
import * as firebase from "firebase";
import * as shortid from "shortid";

export const defaultQueryLimit = 1000;

export async function generateQueryRef<ItemModel>(
  queryRequest: SimpleQuery<ItemModel>,
  collection: string,
  fireStore: firebase.firestore.Firestore,
  startAfter?: any
): Promise<firebase.firestore.CollectionReference> {
  let query = fireStore.collection(collection);

  if (queryRequest.where) {
    for (let i = 0; i < queryRequest.where.length; i++) {
      let w = queryRequest.where[i];
      if (w.length === 3) {
        let [field, operator, value] = queryRequest.where[i];
        query = query.where(field as any, operator, value) as any;
      } else if (w.length === 2) {
        let [item, operator] = queryRequest.where[i];
        let r1 = generateFirestorePathFromObject(item);
        query = query.where(r1.path, operator, r1.value) as any;
      } else {
        console.error("Unknown query request where");
      }
    }
  }
  if (queryRequest.orderBy) {
    for (let i = 0; i < queryRequest.orderBy.length; i++) {
      let orderByDetails = queryRequest.orderBy[i];
      let path =
        typeof orderByDetails.path === "string"
          ? orderByDetails.path
          : generateFirestorePathFromObject(orderByDetails.path).path;
      query = query.orderBy(path as any, orderByDetails.dir || undefined) as any;
    }
  }

  if (queryRequest._internalStartAfterDocId) {
    let startAfterDoc = await fireStore
      .collection(collection)
      .doc(queryRequest._internalStartAfterDocId)
      .get();
    query = query.startAfter(startAfterDoc) as any;
  } else {
    if (queryRequest.startAt) {
      query = query.startAt(...queryRequest.startAt) as any;
    }
  }

  if (queryRequest.endAt) {
    query = query.endAt(...queryRequest.endAt) as any;
  }

  // Lock it to something to prevent massive batches but also to make it easier to detect if we need to paginate
  let limit = queryRequest.limit === undefined ? defaultQueryLimit : queryRequest.limit;
  query = query.limit(limit) as any;

  if (startAfter) {
    query.startAfter(startAfter);
  }

  return query;
}

function generateFirestorePathFromObject(
  obj: any,
  acc: string[] = []
): { path: string; value: boolean | string | number } {
  let type = typeof obj;

  if (["string", "number", "boolean"].includes(type)) {
    return { path: acc.join("."), value: obj };
  }

  let keys = Object.keys(obj);
  if (keys.length > 1) {
    console.warn(`Was expecting to find 1 key but found ${keys.length}`);
  }

  acc.push(keys[0]);

  return generateFirestorePathFromObject(obj[keys[0]], acc);
}

export const generatePushID = (function() {
  // Modeled after base64 web-safe chars, but ordered by ASCII.
  var PUSH_CHARS = "XX0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

  // Timestamp of last push, used to prevent local collisions if you push twice in one ms.
  var lastPushTime = 0;

  // We generate 72-bits of randomness which get turned into 12 characters and appended to the
  // timestamp to prevent collisions with other clients.  We store the last characters we
  // generated because in the event of a collision, we'll use those same characters except
  // "incremented" by one.
  var lastRandChars = [];

  return function() {
    var now = new Date().getTime();
    var duplicateTime = now === lastPushTime;
    lastPushTime = now;

    var timeStampChars = new Array(8);
    for (var i = 7; i >= 0; i--) {
      timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
      // NOTE: Can't use << here because javascript will convert to int and lose the upper bits.
      now = Math.floor(now / 64);
    }
    if (now !== 0) throw new Error("We should have converted the entire timestamp.");

    var id = timeStampChars.join("");

    if (!duplicateTime) {
      for (i = 0; i < 12; i++) {
        lastRandChars[i] = Math.floor(Math.random() * 64);
      }
    } else {
      // If the timestamp hasn't changed since last push, use the same random number, except incremented by 1.
      for (i = 11; i >= 0 && lastRandChars[i] === 63; i--) {
        lastRandChars[i] = 0;
      }
      lastRandChars[i]++;
    }
    for (i = 0; i < 12; i++) {
      id += PUSH_CHARS.charAt(lastRandChars[i]);
    }
    if (id.length != 20) throw new Error("Length should be 20.");

    id = id.substr(1);

    return `${id}${shortid.generate()}`;
  };
})();
