---
title: smoke test
tags: [quoll, codemirror]
---

# Heading

A paragraph with **bold**, *em*, `code`, and a [relative link](./other.md) plus an https://example.com autolink.

| Col A | Col B |
| :--- | ---: |
| left | right |
| `x\|y` | b |

- [ ] open task
- [x] done task
  - nested bullet under a task

![alt text](https://example.com/img.png)

![inert](javascript:alert(1))

```js
// A fence body longer than the collapse threshold (10 lines) so the
// collapse bar renders and the visual smoke can exercise it.
const a = 1;
const b = 2;
const c = 3;
const d = 4;
const e = 5;
const f = 6;
const g = 7;
const h = 8;
const i = 9;
const total = a + b + c + d + e + f + g + h + i;
console.log(total);
```
