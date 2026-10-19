# Changelog

## 1.0.1

- Clearer store listing: the description and search words say what it does and that it rebuilds PHP Namespace Resolver. No code changes.

## 1.0.0

First release of PHP Namespace Mover, built on PHP Namespace Resolver 2.1.3.

- Move or rename a PHP file or folder, and its namespace, class name, imports and references update. Preview the changes first, or update straight away.
- Organize Imports: remove unused, add missing ones with a single match, and sort. On save, from the command palette, and as VS Code's Organize Imports.
- A new PHP tokenizer replaces the pattern matching. It fixes the freeze in #128, #149 and #159.
- Import on save now imports (#156).
- Fixed #136, #138, #140, #141, #146, #151, #152, #153 and #160.
- Remove Unused keeps the used entries of a grouped import.
- A namespace on the `<?php` line is read.
- composer.json mappings to the project root, and the most specific mapping, are used.
- Settings from PHP Namespace Resolver carry over.
