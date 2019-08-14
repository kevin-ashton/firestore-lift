import { FirestoreLift } from "../src/FirestoreLift";
import { BatchRunner } from "../src//BatchRunner";
import { BatchTask, SimpleQuery } from "../src/models";
import * as yup from "yup";
import * as firebase from "firebase";

console.log("Init test");

interface Person {
  id?: string;
  name: string;
  age: number;
  weight: number;
  favFoods: {
    asian: string;
    italian: string;
    american: string;
  };
}

const PersonYup = yup.object().shape({
  id: yup.string().required(),
  name: yup.string().required(),
  age: yup.number().required(),
  weight: yup.number().required(),
  favFoods: yup
    .object()
    .shape({ asian: yup.string().required(), italian: yup.string().required(), american: yup.string().required() })
    .required()
});

// Initialize Firebase
const firebaseConfig = {
  apiKey: "AIzaSyAX6T_6ad-rsPjXfITfj74aIySbQ1CL2L0",
  authDomain: "firestore-lift-sandbox.firebaseapp.com",
  databaseURL: "https://firestore-lift-sandbox.firebaseio.com",
  projectId: "firestore-lift-sandbox",
  storageBucket: "firestore-lift-sandbox.appspot.com",
  messagingSenderId: "965988214603",
  appId: "1:965988214603:web:1f66f5ea87563055"
};
firebase.initializeApp(firebaseConfig);

const batchRunner = new BatchRunner({
  firestore: firebase.firestore
});

let personHelper = new FirestoreLift<Person>({
  collection: "person",
  fireStoreInstance: firebase.firestore(),
  batchRunner,
  yupSchema: PersonYup,
  addIdPropertyByDefault: true,
  prefixIdWithCollection: true
});

const dummyData: Person[] = [
  {
    id: "p1",
    name: "Fred",
    age: 35,
    weight: 200,
    favFoods: {
      american: "burger",
      asian: "orange chicken",
      italian: "pizza"
    }
  },
  {
    id: "p2",
    name: "Bob",
    age: 35,
    weight: 205,
    favFoods: {
      american: "burger",
      asian: "rice",
      italian: "pizza"
    }
  },
  {
    id: "p3",
    name: "Henry",
    age: 2,
    weight: 25,
    favFoods: {
      american: "burger",
      asian: "miso soup",
      italian: "pizza"
    }
  },
  {
    id: "p4",
    name: "Elaine",
    age: 4,
    weight: 30,
    favFoods: {
      american: "burger",
      asian: "sushi",
      italian: "pizza"
    }
  }
];

let malformedObject: any = {
  id: "p5",
  name: "Bad Object",
  age: 4,
  weight: 30,
  favFoods: {
    asian: "sushi",
    italian: "pizza"
  }
};

async function resetData() {
  console.log("Reset data");
  let batchTasks: BatchTask[] = [];
  for (let i = 0; i < dummyData.length; i++) {
    batchTasks.push(await personHelper.add({ item: dummyData[i] }, { returnBatchTask: true }));
  }
  try {
    await batchRunner.executeBatch(batchTasks);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

async function main() {
  try {
    // Email: test@example.com
    // Password: 2*******y
    await firebase
      .auth()
      .signInWithEmailAndPassword(
        process.env.FIRESTORE_LIFT_EXAMPLE_USER_EMAIL,
        process.env.FIRESTORE_LIFT_EXAMPLE_USER_PASSWORD
      );
    await resetData();

    let batch: BatchTask[] = [];

    console.log("-----------------------------------");
    console.log("Fetch 1 Person");
    console.log("-----------------------------------");
    let r1 = await personHelper.get([dummyData[0].id]);
    let p1 = r1[0];
    console.log(p1);

    console.log("-----------------------------------");
    console.log("Fetch 2 People");
    console.log("-----------------------------------");
    // Fetch 2 people
    let people = await personHelper.get([dummyData[0].id, dummyData[2].id]);
    console.log(people);

    console.log("-----------------------------------");
    console.log("Batch Test (add, delete)");
    console.log("-----------------------------------");
    console.log("Add a person");
    p1.name = "Kevin Ashton";
    batch.push(
      await personHelper.add(
        {
          item: {
            id: "p10",
            age: 60,
            name: "Sue",
            weight: 120,
            favFoods: { american: "cheese", asian: "orange chicken", italian: "pizza" }
          }
        },
        { returnBatchTask: true }
      )
    );

    console.log("Delete a person");
    batch.push(await personHelper.delete({ id: dummyData[1].id }, { returnBatchTask: true }));

    console.log("Execute batch");
    await batchRunner.executeBatch(batch);

    console.log("-----------------------------------");
    console.log("Run Query 1");
    console.log("-----------------------------------");
    let res2 = await personHelper.query({
      limit: 100,
      where: [{ age: [">=", 0] }],
      orderBy: [{ pathObj: { age: true } }, { pathObj: { favFoods: { asian: true } }, dir: "desc" }],
      startAt: [35, "orange chicken"]
    });
    console.log(JSON.stringify(res2, null, 2));

    console.log("-----------------------------------");
    console.log("Run Query 2");
    console.log("-----------------------------------");
    let res3 = await personHelper.query({
      limit: 100,
      where: [{ favFoods: { asian: ["==", "orange chicken"] } }]
    });
    console.log(JSON.stringify(res3, null, 2));

    console.log("-----------------------------------");
    console.log("Run Subscription");
    console.log("-----------------------------------");
    console.log(personHelper.getSubscriptionCount());
    let subTest2 = await personHelper.querySubscription({});

    let subR1 = subTest2.subscribe((data) => {
      console.log("---------------------------------");
      console.log("Data coming");
      console.log(JSON.stringify(data.items));
      console.log(data.metadata);
    });
    console.log(personHelper.getSubscriptionCount());
    await new Promise((r) => setTimeout(() => r(), 1000));
    console.log("Modify some data. Should come in as part of subscription.");
    await personHelper.update({ id: dummyData[0].id, item: { age: 99 } });
    await new Promise((r) => setTimeout(() => r(), 1000));
    subR1.unsubscribe();
    console.log(personHelper.getSubscriptionCount());

    try {
      console.log("-----------------------------------");
      console.log("Try to insert a malformed person");
      console.log("-----------------------------------");
      await personHelper.add({ item: malformedObject });
    } catch (e) {
      console.log(e);
      console.log("Caught bad person insert");
    }

    try {
      console.log("-----------------------------------");
      console.log("Fetch id for person that doesn't exist");
      console.log("-----------------------------------");
      let res = await personHelper.get(["345343"]);
      console.log(res);
    } catch (e) {
      console.log(e);
      console.log("Caught bad id request");
    }

    console.log("-----------------------------------");
    console.log("Query Pagination Testing");
    console.log("-----------------------------------");

    const runPersonPaginationTest = async (query: SimpleQuery<Person>) => {
      let k1 = await personHelper.query(query);
      console.log(JSON.stringify(k1.items));
      if (k1.nextQuery) {
        console.log("------------------------------------------------");
        console.log("Appears to be more data to pagination. Run again");
        await runPersonPaginationTest(k1.nextQuery);
      } else {
        console.log("------------------------------------------------");
        console.log("No more pagination queries to run");
      }
    };

    await runPersonPaginationTest({ limit: 2 });

    console.log("-----------------------------------");
    console.log("Delete from path using an update");
    console.log("-----------------------------------");

    await personHelper.update({
      id: "p1",
      item: {
        favFoods: {
          american: personHelper.getDeleteMagicValue(),
          asian: personHelper.getDeleteMagicValue(),
          italian: "good pizza"
        }
      }
    });
    let personAfterUpdate = (await personHelper.get(["p1"]))[0];
    console.log(JSON.stringify(personAfterUpdate));

    console.log("-----------------------------------");
    console.log("Check set path");
    console.log("-----------------------------------");

    await personHelper.setPath({
      id: "p4",
      pathObj: { favFoods: true },
      value: { favFoods: { american: "yummy hot dog", asian: "yummy sushi" } }
    });

    let personAfterUpdate2 = (await personHelper.get(["p4"]))[0];
    console.log(JSON.stringify(personAfterUpdate2));

    console.log("Finish");
  } catch (e) {
    console.log("Error");
    console.log(e);
  }
  process.exit(0);
}

main();
