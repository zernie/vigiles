# @vigiles/eslint-config (private)

The strict lint rules vigiles and paperlint share: size limits, functional
rules, no type assertions, and `layers()`, the hexagonal boundary.

**This is not part of vigiles' API.** It has no entry in vigiles' `exports`, no
version of its own, and it can change in any release without notice. It ships
inside the `vigiles` npm package only so that paperlint can import it by path:

```js
// PRIVATE file of vigiles, not a public API. If it moves, this import fails loudly.
import { layers } from "./node_modules/vigiles/packages/eslint-config/index.mjs";
```

Nobody else should depend on it. The plugins it uses (eslint-plugin-boundaries,
eslint-plugin-functional, eslint-plugin-sonarjs, typescript-eslint) are not
bundled; the importing repo installs its own.
