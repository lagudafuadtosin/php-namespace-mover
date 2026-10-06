import * as vscode from 'vscode';
import * as path from 'path';
import { NamespaceCache } from '../core/NamespaceCache';
import { planMove, applyChanges } from '../core/moveRefactor';
import { analyzePhp } from '../core/php/analysis';
import { namespaceForFile } from '../core/composerNamespace';
import { showStatusMessage } from '../utils/statusBar';

type UpdateMode = 'ask' | 'always' | 'never';

const EXCLUDE = '{**/vendor/**,**/node_modules/**,**/.git/**}';

/**
 * When PHP files or folders are moved or renamed, updates the namespace and class name to
 * match composer.json (PSR-4), and every import and reference to them across the workspace.
 */
export class MoveFiles implements vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[];
    private readonly previewTexts = new Map<string, string>();

    constructor(private readonly cache: NamespaceCache) {
        this.subscriptions = [
            vscode.workspace.onDidRenameFiles(event => this.onRenamed(event)),
            vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
                provideTextDocumentContent: uri => this.previewTexts.get(uri.toString()) ?? '',
            }),
        ];
    }

    dispose(): void {
        this.subscriptions.forEach(s => s.dispose());
    }

    private async onRenamed(event: vscode.FileRenameEvent): Promise<void> {
        const mode = vscode.workspace.getConfiguration('phpNamespaceMover').get<UpdateMode>('updateReferencesOnMove', 'ask');
        if (mode === 'never') { return; }

        try {
            const moves = await this.expandMoves(event.files);
            if (moves.length === 0) { return; }
            await this.updateAfterMoves(moves, mode);
        } catch (error: any) {
            showStatusMessage(`PHP move: ${error.message}`);
        }
    }

    /** Folder moves become one move per PHP file inside. */
    private async expandMoves(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]) {
        const moves: { oldUri: vscode.Uri; newUri: vscode.Uri }[] = [];
        for (const { oldUri, newUri } of files) {
            const stat = await vscode.workspace.fs.stat(newUri);
            if (stat.type & vscode.FileType.Directory) {
                const inside = await vscode.workspace.findFiles(new vscode.RelativePattern(newUri, '**/*.php'), EXCLUDE);
                for (const uri of inside) {
                    const relative = path.relative(newUri.fsPath, uri.fsPath);
                    moves.push({ oldUri: vscode.Uri.file(path.join(oldUri.fsPath, relative)), newUri: uri });
                }
            } else if (newUri.fsPath.toLowerCase().endsWith('.php')) {
                moves.push({ oldUri, newUri });
            }
        }
        return moves;
    }

    async updateAfterMoves(moves: { oldUri: vscode.Uri; newUri: vscode.Uri }[], mode: UpdateMode): Promise<boolean> {
        const texts = new Map<string, string>();
        const read = async (uri: vscode.Uri) => {
            const key = uri.toString();
            if (!texts.has(key)) {
                const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
                texts.set(key, open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
            }
            return texts.get(key)!;
        };

        // Work out each moved class's new name, and which files could mention any of them
        const plans: { uri: vscode.Uri; newNamespace: string; newClassName: string; oldName: string }[] = [];
        for (const move of moves) {
            const analysis = analyzePhp(await read(move.newUri));
            const declaration = analysis.declarations[0];
            if (!declaration) { continue; }
            const oldBase = path.basename(move.oldUri.fsPath, '.php');
            const newBase = path.basename(move.newUri.fsPath, '.php');
            const newClassName = declaration.name === oldBase && oldBase !== newBase ? newBase : declaration.name;
            const newNamespace = (await namespaceForFile(move.newUri)) ?? analysis.namespace?.name ?? '';
            plans.push({ uri: move.newUri, newNamespace, newClassName, oldName: declaration.name });
        }
        if (plans.length === 0) { return false; }

        const names = [...new Set(plans.map(p => p.oldName))];
        for (const uri of await vscode.workspace.findFiles('**/*.php', EXCLUDE)) {
            if (texts.has(uri.toString())) { continue; }
            const raw = await vscode.workspace.fs.readFile(uri);
            const buffer = Buffer.from(raw);
            if (names.some(n => buffer.includes(n))) { texts.set(uri.toString(), buffer.toString('utf8')); }
        }

        // Plan each move on the result of the previous ones
        const original = new Map(texts);
        const summary: string[] = [];
        let references = 0;
        for (const plan of plans) {
            const movedKey = plan.uri.toString();
            const oldNamespace = analyzePhp(texts.get(movedKey)!).namespace?.name ?? '';
            const result = planMove({
                moved: { uri: movedKey, text: texts.get(movedKey)! },
                newNamespace: plan.newNamespace,
                newClassName: plan.newClassName,
                oldNamespaceSiblings: oldNamespace ? this.cache.classesInNamespace(oldNamespace) : [],
                files: [...texts].filter(([uri]) => uri !== movedKey).map(([uri, text]) => ({ uri, text })),
            });
            if (!result) { continue; }
            summary.push(`${result.oldFqcn} → ${result.newFqcn}`);
            for (const file of result.files) {
                texts.set(file.uri, applyChanges(texts.get(file.uri)!, file.changes));
                if (file.uri !== movedKey) { references += file.changes.length; }
            }
        }

        const changed = [...texts].filter(([uri, text]) => original.get(uri) !== text);
        if (changed.length === 0) { return false; }

        if (mode === 'ask') {
            const what = summary.length === 1 ? summary[0] : `${summary.length} classes`;
            const question = `Moved ${what}. Update the namespace and ${references} reference${references === 1 ? '' : 's'} in ${changed.length} file${changed.length === 1 ? '' : 's'}?`;
            let choice = await vscode.window.showInformationMessage(question, 'Update', 'Preview', 'Skip');
            if (choice === 'Preview') {
                await this.showPreview(changed);
                choice = await vscode.window.showInformationMessage(
                    `Apply the changes shown to ${changed.length} file${changed.length === 1 ? '' : 's'}?`, 'Update', 'Skip');
            }
            if (choice !== 'Update') { return false; }
        }

        const edit = new vscode.WorkspaceEdit();
        for (const [uri, text] of changed) {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
            const full = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
            edit.replace(document.uri, full, text);
        }
        const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
        if (applied) {
            showStatusMessage(`$(check) Updated ${changed.length} file${changed.length === 1 ? '' : 's'}.`);
        }
        return applied;
    }

    /**
     * Shows every planned change as a diff (the multi-file diff view where VS Code has it,
     * otherwise one diff per file) without touching the files.
     */
    private async showPreview(changed: [string, string][]): Promise<void> {
        this.previewTexts.clear();
        const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
        for (const [uri, text] of changed) {
            const original = vscode.Uri.parse(uri);
            const proposed = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: original.path, query: String(resources.length) });
            this.previewTexts.set(proposed.toString(), text);
            resources.push([original, original, proposed]);
        }
        try {
            await vscode.commands.executeCommand('vscode.changes', 'PHP namespace and reference changes', resources);
        } catch {
            for (const [original, , proposed] of resources) {
                await vscode.commands.executeCommand('vscode.diff', original, proposed,
                    `${original.path.split('/').pop()} (proposed)`, { preview: false });
            }
        }
    }
}

const PREVIEW_SCHEME = 'php-move-preview';
