import * as assert from 'assert';
import * as vscode from 'vscode';
import { PhpClassDetector } from '../../core/PhpClassDetector';
import { DeclarationParser } from '../../core/DeclarationParser';
import { NamespaceCache } from '../../core/NamespaceCache';
import { SortManager } from '../../core/SortManager';
import { OrganizeImports } from '../../features/OrganizeImports';
import { DiagnosticManager } from '../../features/DiagnosticManager';
import { DiagnosticCode, CacheEntry } from '../../types';
import { createDocument } from './helper';

class FakeNamespaceCache extends NamespaceCache {
    private entries = new Map<string, CacheEntry[]>();

    addEntry(className: string, fqcn: string): void {
        this.entries.set(className, [...(this.entries.get(className) ?? []), {
            fqcn,
            uri: vscode.Uri.file(`/fake/${className}.php`),
            className,
        }]);
    }

    override lookup(className: string): CacheEntry[] {
        return this.entries.get(className) ?? [];
    }
}

async function applied(document: vscode.TextDocument, edits: vscode.TextEdit[]): Promise<string> {
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, edits);
    await vscode.workspace.applyEdit(edit);
    return document.getText();
}

suite('OrganizeImports (VS Code Integration)', () => {
    const detector = new PhpClassDetector();
    const parser = new DeclarationParser();
    const sortManager = new SortManager(parser);
    let cache: FakeNamespaceCache;
    let organize: OrganizeImports;

    setup(() => {
        cache = new FakeNamespaceCache();
        organize = new OrganizeImports(detector, parser, cache, sortManager);
    });

    test('#156: adds a missing import that has exactly one match', async () => {
        cache.addEntry('User', 'App\\Models\\User');
        const doc = await createDocument('<?php\n\nnamespace App\\Http;\n\nclass Controller {\n    public function show(User $user) {}\n}\n');
        const result = await applied(doc, organize.computeEdits(doc, { remove: false, add: true, sort: false }));
        assert.ok(result.includes('use App\\Models\\User;'), result);
    });

    test('leaves an ambiguous class for the Import command', async () => {
        cache.addEntry('Request', 'App\\Http\\Request');
        cache.addEntry('Request', 'Illuminate\\Http\\Request');
        const doc = await createDocument('<?php\n\nnamespace App\\Http;\n\nclass Controller {\n    public function show(Request $r) {}\n}\n');
        assert.deepStrictEqual(organize.computeEdits(doc, { remove: false, add: true, sort: false }), []);
    });

    test('removes unused imports, adds missing ones and sorts in one edit', async () => {
        cache.addEntry('Collection', 'Illuminate\\Support\\Collection');
        const doc = await createDocument('<?php\n\nnamespace App;\n\nuse Zeta\\Used;\nuse Alpha\\Unused;\n\nclass Foo {\n    public function a(Used $u): Collection {}\n}\n');
        const result = await applied(doc, organize.computeEdits(doc, { remove: true, add: true, sort: true }));
        assert.ok(!result.includes('Alpha\\Unused'), result);
        assert.ok(result.includes('use Zeta\\Used;'), result);
        assert.ok(result.includes('use Illuminate\\Support\\Collection;'), result);
    });

    test('keeps the used entries of a grouped import', async () => {
        const doc = await createDocument('<?php\n\nnamespace App;\n\nuse App\\Models\\{User, Post};\n\nclass Foo {\n    public function a(User $u) {}\n}\n');
        const result = await applied(doc, organize.computeEdits(doc, { remove: true, add: false, sort: false }));
        assert.ok(result.includes('use App\\Models\\{User};'), result);
    });

    test('#152: removes an unused import whose class repeats its namespace', async () => {
        const doc = await createDocument('<?php\n\nnamespace App;\n\nuse Carbon\\Carbon;\n\nclass Foo {}\n');
        const result = await applied(doc, organize.computeEdits(doc, { remove: true, add: false, sort: false }));
        assert.ok(!result.includes('Carbon'), result);
    });

    test('#141: a global class used in a file without a namespace needs no import', async () => {
        cache.addEntry('Mockery', 'Mockery');
        const manager = new DiagnosticManager(detector, parser, cache);
        const doc = await createDocument('<?php\n\nclass FooTest {\n    public function a() { return Mockery::mock(Bar::class); }\n}\n');
        manager.update(doc);
        const notImported = manager.getDiagnostics(doc.uri).filter(d => d.code === DiagnosticCode.ClassNotImported);
        assert.ok(!notImported.some(d => d.message.includes("'Mockery'")));
        manager.dispose();
    });
});
