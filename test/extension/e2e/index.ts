import { readdirSync } from "node:fs";
import * as path from "node:path";

import Mocha = require("mocha");

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 30000,
    reporter: "spec",
  });

  const testsRoot = __dirname;
  const testFiles = readdirSync(testsRoot).filter((f) => f.endsWith(".test.js"));
  for (const file of testFiles) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
