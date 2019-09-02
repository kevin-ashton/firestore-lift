# firestore-lift

## Purpose

Wrapper for firestore that provides types for the documents and most common firestore functions such as queries.

## Example

See `test/test.ts` for full example


### Limitations

* Expects every document in every collection to have an `id` property that matches the firestore document key
* Does not support sub-collections
* Does not support collection-groups
* Does not support array data types (they are stored as objects anyway)
