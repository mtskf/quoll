---
title: a11y audit fixture
tags: [quoll, a11y]
---

# Heading one

## Heading two

A paragraph with **bold**, *em*, `code`, a [relative link](./other.md), and an
https://example.com autolink for link-contrast sampling.

> [!NOTE]
> A callout blockquote — display-only accent border + tint (HC-contrast sample).

| Col A | Col B |
| :--- | ---: |
| left | right |
| `x\|y` | b |

- [ ] open task
- [x] done task

![alt text](https://example.com/img.png)

![](https://example.com/decorative.png)

![inert](javascript:alert(1))

---

```js
// A fence body longer than the collapse threshold (10 lines) so the collapse
// bar, copy button, and language picker all render for the probe.
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
