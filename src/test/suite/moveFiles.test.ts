import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { NamespaceCache } from '../../core/NamespaceCache';
import { MoveFiles } from '../../features/MoveFiles';
import { CacheEntry } from '../../types';

class FakeNamespaceCache extends NamespaceCache {
    constructor(private readonly classes: Record<string, string> = {}) { super(); }

    override lookup(className: string): CacheEntry[] {
        const fqcn = this.classes[className];
        return fqcn ? [{ fqcn, className, uri: vscode.Uri.file(`/fake/${className}.php`) }] : [];
    }

    override classesInNamespace(namespace: string): string[] {
        return Object.entries(this.classes)
            .filter(([name, fqcn]) => fqcn === `${namespace}\\${name}`)
            .map(([name]) => name);
    }
}

const encoder = new TextEncoder();
async function write(root: vscode.Uri, relative: string, text: string) {
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, relative), encoder.encode(text));
}
async function read(root: vscode.Uri, relative: string): Promise<string> {
    const uri = vscode.Uri.joinPath(root, relative);
    const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
    return open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

suite('MoveFiles (VS Code Integration)', () => {
    const folder = () => vscode.workspace.workspaceFolders![0].uri;

    suiteSetup(async () => {
        const root = folder();
        await write(root, 'composer.json', JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }));
        await write(root, 'src/Models/User.php', '<?php\n\nnamespace App\\Models;\n\nclass User extends Model\n{\n}\n');
        await write(root, 'src/Models/Model.php', '<?php\n\nnamespace App\\Models;\n\nabstract class Model\n{\n}\n');
        await write(root, 'src/Models/Post.php', '<?php\n\nnamespace App\\Models;\n\nclass Post extends Model\n{\n    public function author(): User { return new User(); }\n}\n');
        await write(root, 'src/Http/UserController.php', '<?php\n\nnamespace App\\Http;\n\nuse App\\Models\\User;\n\nclass UserController\n{\n    /** @return \\App\\Models\\User */\n    public function show(User $user) { return $user; }\n}\n');
    });

    test('moving a class file updates its namespace, its imports and its references', async function () {
        this.timeout(30000);
        const root = folder();
        const oldUri = vscode.Uri.joinPath(root, 'src/Models/User.php');
        const newUri = vscode.Uri.joinPath(root, 'src/Domain/Accounts/User.php');
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'src/Domain/Accounts'));
        await vscode.workspace.fs.rename(oldUri, newUri);

        const cache = new FakeNamespaceCache({ Model: 'App\\Models\\Model', Post: 'App\\Models\\Post', User: 'App\\Models\\User' });
        const mover = new MoveFiles(cache);
        try {
            const applied = await mover.updateAfterMoves([{ oldUri, newUri }], 'always');
            assert.ok(applied);
        } finally {
            mover.dispose();
        }

        const user = await read(root, 'src/Domain/Accounts/User.php');
        assert.ok(user.includes('namespace App\\Domain\\Accounts;'), user);
        assert.ok(user.includes('use App\\Models\\Model;'), user);

        const controller = await read(root, 'src/Http/UserController.php');
        assert.ok(controller.includes('use App\\Domain\\Accounts\\User;'), controller);
        assert.ok(controller.includes('@return \\App\\Domain\\Accounts\\User'), controller);

        const post = await read(root, 'src/Models/Post.php');
        assert.ok(post.includes('use App\\Domain\\Accounts\\User;'), post);
    });

    test('moving a folder updates every class inside it and its references', async function () {
        this.timeout(30000);
        const root = folder();
        await write(root, 'src/Billing/Invoice.php', '<?php\n\nnamespace App\\Billing;\n\nclass Invoice\n{\n    public function lines(): array { return [new Line()]; }\n}\n');
        await write(root, 'src/Billing/Line.php', '<?php\n\nnamespace App\\Billing;\n\nclass Line\n{\n}\n');
        await write(root, 'src/Http/InvoiceController.php', '<?php\n\nnamespace App\\Http;\n\nuse App\\Billing\\Invoice;\nuse App\\Billing\\Line;\n\nclass InvoiceController\n{\n    public function show(Invoice $i, Line $l) {}\n}\n');

        const oldDir = vscode.Uri.joinPath(root, 'src/Billing');
        const newDir = vscode.Uri.joinPath(root, 'src/Finance');
        await vscode.workspace.fs.rename(oldDir, newDir);

        const mover = new MoveFiles(new FakeNamespaceCache({ Invoice: 'App\\Billing\\Invoice', Line: 'App\\Billing\\Line' }));
        try {
            const moves = await (mover as any).expandMoves([{ oldUri: oldDir, newUri: newDir }]);
            assert.strictEqual(moves.length, 2);
            assert.ok(await mover.updateAfterMoves(moves, 'always'));
        } finally {
            mover.dispose();
        }

        const invoice = await read(root, 'src/Finance/Invoice.php');
        assert.ok(invoice.includes('namespace App\\Finance;'), invoice);
        assert.ok(!invoice.includes('use App\\Billing'), invoice);
        assert.ok(!invoice.includes('use App\\Finance\\Line'), 'Line moved with it, so no import is needed');
        const line = await read(root, 'src/Finance/Line.php');
        assert.ok(line.includes('namespace App\\Finance;'), line);
        const controller = await read(root, 'src/Http/InvoiceController.php');
        assert.ok(controller.includes('use App\\Finance\\Invoice;'), controller);
        assert.ok(controller.includes('use App\\Finance\\Line;'), controller);
    });

    test('renaming a class file renames the class and its uses', async function () {
        this.timeout(30000);
        const root = folder();
        const oldUri = vscode.Uri.joinPath(root, 'src/Domain/Accounts/User.php');
        const newUri = vscode.Uri.joinPath(root, 'src/Domain/Accounts/Member.php');
        await vscode.workspace.saveAll(false);
        await vscode.workspace.fs.rename(oldUri, newUri);

        const mover = new MoveFiles(new FakeNamespaceCache({ Model: 'App\\Models\\Model' }));
        try {
            assert.ok(await mover.updateAfterMoves([{ oldUri, newUri }], 'always'));
        } finally {
            mover.dispose();
        }

        const member = await read(root, 'src/Domain/Accounts/Member.php');
        assert.ok(member.includes('class Member extends Model'), member);

        const controller = await read(root, 'src/Http/UserController.php');
        assert.ok(controller.includes('use App\\Domain\\Accounts\\Member;'), controller);
        assert.ok(controller.includes('show(Member $user)'), controller);
        assert.ok(controller.includes('@return \\App\\Domain\\Accounts\\Member'), controller);
        assert.ok(path.basename(newUri.fsPath) === 'Member.php');
    });
});
