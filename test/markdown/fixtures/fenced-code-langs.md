<!-- case: fenced code blocks — language info string must round-trip on every variant -->
Plain fence, no language:

```
const x = 1;
```

JavaScript:

```javascript
const greet = (name) => `hello, ${name}`;
```

TypeScript with shorthand:

```ts
type Id = string & { __brand: 'Id' };
```

Shell:

```bash
echo "hello" | tr a-z A-Z
```

Diff:

```diff
- old line
+ new line
```

Unknown language label:

```mystery
arbitrary content
```
