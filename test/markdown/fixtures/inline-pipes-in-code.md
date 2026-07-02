<!-- case: inline code containing pipe chars — must not be parsed as table cells -->
Use `a | b` to express alternation in regex docs.

Even inside a table the pipe must survive:

| Pattern    | Meaning           |
| ---------- | ----------------- |
| `a\|b`     | a or b            |
| `(x\|y)+`  | one or more x/y   |

Trailing paragraph with `if (x) { return a \| b; }` inline.
