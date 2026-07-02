<!-- case: math-adjacent special chars (<, >, &) outside of HTML — must not be parsed as tags or entities -->
When a < b and b > c, then a < c.

Inequalities like `x < 10 && y > 20` should round-trip without HTML escaping.

A KaTeX-style inline expression: $a < b \le c$ alongside `x &amp; y` literal.

Block-level pseudo-math:

```math
\sum_{i=0}^{n} (x_i < y_i) \quad \text{and} \quad a \& b > 0
```
