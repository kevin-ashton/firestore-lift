function generateFirestorePathFromObject(obj, acc = []) {
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

console.log(generateFirestorePathFromObject({ cat: { dog: { worm: 5 } } }));
