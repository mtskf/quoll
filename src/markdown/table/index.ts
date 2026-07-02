// src/markdown/table/index.ts
// `findTableRanges` is INTENTIONALLY not re-exported. It is an internal
// helper for parseAllTables; production consumers (C6b) get table
// ranges from Lezer's syntaxTree.
export type {
  Align,
  Cell,
  CellRaw,
  DelimiterCell,
  DelimiterRow,
  LineEnding,
  Row,
  Table,
} from "./model.js";
export { tableAlign, toCellRaw } from "./model.js";
export { parseTable } from "./parse.js";
export { serializeTable } from "./serialize.js";
export { deleteColumn, deleteRow, insertColumn, insertRow } from "./structure.js";
