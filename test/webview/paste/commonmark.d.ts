declare module "commonmark" {
  interface Node {
    readonly type: string;
    readonly literal: string | null;
    readonly firstChild: Node | null;
    readonly next: Node | null;
    /** `[[startLine, startCol], [endLine, endCol]]`, 1-based. */
    readonly sourcepos: [[number, number], [number, number]];
  }

  export class Parser {
    parse(input: string): Node;
  }
}
