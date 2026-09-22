import { resolve } from "node:path";
import { openDatabase, reseed } from "../src/db/store.js";

const dbPath = resolve(process.cwd(), process.argv[2] ?? "data/wing.db");
const db = openDatabase(dbPath);
reseed(db);
console.log(`已重置为固定 fixture：${dbPath}`);
