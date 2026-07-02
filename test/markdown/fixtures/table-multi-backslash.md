<!-- case: GFM table with multi-backslash escapes — \\ (esc bs as content), \\\| (esc bs + esc pipe), and end-of-row `\\|` (esc bs + unescaped trailing pipe) -->
| Pattern        | Sub-case                        |
| -------------- | ------------------------------- |
| `a\\` then `b` | esc bs as content (code span)   |
| `a\\\|b`       | esc bs + escaped pipe (content) |
| trailing       | here\\|
