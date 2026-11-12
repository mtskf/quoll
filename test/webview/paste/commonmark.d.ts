declare module "commonmark" {
  interface Node {
    readonly type: string;
    readonly literal: string | null;
    readonly firstChild: Node | null;
    readonly next: Node | null;
  }

  export class Parser {
    parse(input: string): Node;
  }
}
