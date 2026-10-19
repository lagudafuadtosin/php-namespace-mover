# PHP Namespace Mover

Move or rename a PHP file and its namespace and every reference follow. It also imports, organizes and tidies your `use` statements, and it does not freeze VS Code.

PHP Namespace Mover is built on [PHP Namespace Resolver](https://github.com/MehediDracula/PHP-Namespace-Resolver) by Mehedi Hasan, under the MIT licence. It is a separate extension and is not made or endorsed by him.

Coming from PHP Namespace Resolver? The commands do the same jobs, and your settings carry over.

## Move and rename

- **Move a file.** Drag a PHP file to another folder. Its namespace changes to match your `composer.json` (PSR-4 or PSR-0). Every `use` line, full class name and PHPDoc reference in your project changes with it.
- **Rename a file.** Rename `User.php` to `Member.php`. The class becomes `Member`, and so does every use of it.
- **Move a folder.** Every PHP file inside is updated the same way.
- **Nothing breaks.** Files that shared the old namespace get the `use` line they now need. So does the moved file, for the classes it left behind.
- **See it first.** Choose **Preview** to see every change side by side before anything is written. Or choose **Update** to go straight ahead.

You can set this to ask, always update, or never update.

## Imports

- **Import Class** adds the `use` line for the class under the cursor.
- **Import All Classes** imports every class the file uses.
- **Organize Imports** removes unused imports, adds missing ones that have only one match, and sorts. It works on save, from the command palette, and with VS Code's own Organize Imports.
- **Expand Class** writes the full class name in place.
- **Sort Imports** sorts by natural order, length or alphabet.
- **Remove Unused Imports** removes what you do not use. It keeps the rest of a grouped import.
- **Generate Namespace** writes the namespace for the file's folder from `composer.json`.
- **Warnings** show classes that are used but not imported, and imports that are not used. Quick fixes are one click away.

## Does not freeze

PHP Namespace Mover reads PHP with a real tokenizer instead of guessing with patterns. A line like this used to freeze PHP Namespace Resolver for almost a minute:

```php
$cache->set(trim($a), trim($a), trim($a), trim($a), json_encode(array_values($items)));
```

Now it takes less than a millisecond. A file with 2,000 methods is read in under 100 ms.

## Fixed from PHP Namespace Resolver

Each of these has a test.

- Freezing and high CPU: [#128](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/128), [#149](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/149), [#159](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/159)
- Import on save did nothing: [#156](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/156)
- `NULL` reported as a class: [#136](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/136)
- A class used only in `@var` marked unused: [#138](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/138)
- Classes inside `<?= ?>` marked unused: [#140](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/140)
- Global classes flagged in files without a namespace: [#141](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/141)
- Typed constants read as classes: [#146](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/146)
- Imports placed inside anonymous Livewire classes: [#151](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/151)
- `use Carbon\Carbon;` could not be removed: [#152](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/152)
- Words in HTML flagged as classes: [#153](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/153)
- `private(set)` promoted properties marked unused: [#160](https://github.com/MehediDracula/PHP-Namespace-Resolver/issues/160)

## Coming from PHP Namespace Resolver

Your settings carry over. Turn PHP Namespace Resolver off, because both use the same shortcuts.

## Commands

| Command | Shortcut |
|---|---|
| Import Class | `Ctrl+Alt+I` |
| Import All Classes | `Ctrl+Alt+A` |
| Expand Class | `Ctrl+Alt+E` |
| Sort Imports | `Ctrl+Alt+S` |
| Generate Namespace | `Ctrl+Alt+G` |
| Remove Unused Imports | `Ctrl+Alt+R` |
| Organize Imports | |
| Rebuild Namespace Index | |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `phpNamespaceMover.updateReferencesOnMove` | `ask` | After a move or rename: `ask`, `always` or `never` update |
| `phpNamespaceMover.sortOnSave` | `false` | Sort imports on save |
| `phpNamespaceMover.removeOnSave` | `false` | Remove unused imports on save |
| `phpNamespaceMover.autoImportOnSave` | `false` | Import classes that have only one match on save |
| `phpNamespaceMover.autoSort` | `true` | Sort after adding an import |
| `phpNamespaceMover.sortMode` | `natural` | `natural`, `length` or `alphabetical` |
| `phpNamespaceMover.leadingSeparator` | `true` | Start expanded class names with `\` |
| `phpNamespaceMover.highlightNotImported` | `true` | Warn about classes that are not imported |
| `phpNamespaceMover.highlightNotUsed` | `true` | Warn about imports that are not used |
| `phpNamespaceMover.ignoreList` | `[]` | Class names to leave out of warnings |
| `phpNamespaceMover.exclude` | `**/node_modules/**` | Files to skip when looking for classes |

## Privacy

PHP Namespace Mover makes no network requests and collects nothing. It only reads the PHP files in your workspace.

## Credit

PHP Namespace Resolver was created by Mehedi Hasan ([MehediDracula](https://github.com/MehediDracula)) and its contributors. PHP Namespace Mover keeps its history. Thanks also to the people who reported the issues above, and to those who first found the cause of the freeze in #149 and #159.

## Licence

MIT, the same as PHP Namespace Resolver. See [LICENSE](LICENSE).

## Problems and ideas

[Open an issue](https://github.com/lagudafuadtosin/php-namespace-mover/issues).
