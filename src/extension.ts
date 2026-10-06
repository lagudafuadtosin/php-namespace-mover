import * as vscode from 'vscode';

import { PhpClassDetector } from './core/PhpClassDetector';
import { DeclarationParser } from './core/DeclarationParser';
import { NamespaceCache } from './core/NamespaceCache';
import { NamespaceResolver } from './core/NamespaceResolver';
import { ImportManager } from './core/ImportManager';
import { SortManager } from './core/SortManager';
import { NamespaceGenerator } from './core/NamespaceGenerator';
import { ImportCommand } from './features/ImportCommand';
import { ExpandCommand } from './features/ExpandCommand';
import { SortCommand } from './features/SortCommand';
import { GenerateNamespaceCommand } from './features/GenerateNamespaceCommand';

import { RemoveUnusedCommand } from './features/RemoveUnusedCommand';
import { DiagnosticManager } from './features/DiagnosticManager';
import { PhpCodeActionProvider } from './features/CodeActionProvider';
import { OrganizeImports } from './features/OrganizeImports';
import { MoveFiles } from './features/MoveFiles';
import { getConfig } from './utils/config';
import { showStatusMessage, disposeStatusBar } from './utils/statusBar';

export function activate(context: vscode.ExtensionContext): void {
    const detector = new PhpClassDetector();
    const parser = new DeclarationParser();
    const cache = new NamespaceCache(context.storageUri);
    const resolver = new NamespaceResolver(cache);
    const sortManager = new SortManager(parser);
    const importManager = new ImportManager(parser, (editor) => sortManager.sort(editor));
    const generator = new NamespaceGenerator(parser);

    const importCommand = new ImportCommand(detector, parser, resolver, importManager);
    const expandCommand = new ExpandCommand(resolver, importManager);
    const sortCommand = new SortCommand(sortManager);
    const generateNsCommand = new GenerateNamespaceCommand(generator);
    const removeUnusedCommand = new RemoveUnusedCommand(detector, parser);
    const diagnosticManager = new DiagnosticManager(detector, parser, cache);
    const organizeImports = new OrganizeImports(detector, parser, cache, sortManager);

    cache.initialize();

    context.subscriptions.push(
        vscode.commands.registerCommand('phpNamespaceMover.import', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            if (editor.selections.length === 1) {
                await importCommand.importSingle(editor.selections[0]);
            } else {
                await importCommand.importMultiple(editor.selections);
            }
        }),

        vscode.commands.registerCommand('phpNamespaceMover.importAll', () => {
            return importCommand.importAll();
        }),

        vscode.commands.registerCommand('phpNamespaceMover.expand', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            if (editor.selections.length === 1) {
                await expandCommand.expand(editor.selections[0]);
            } else {
                await expandCommand.expandMultiple(editor.selections);
            }
        }),

        vscode.commands.registerCommand('phpNamespaceMover.sort', () => {
            sortCommand.execute();
        }),

        vscode.commands.registerCommand('phpNamespaceMover.generateNamespace', () => {
            return generateNsCommand.execute();
        }),

        vscode.commands.registerCommand('phpNamespaceMover.removeUnused', () => {
            return removeUnusedCommand.execute();
        }),

        vscode.commands.registerCommand('phpNamespaceMover.rebuildIndex', async () => {
            await cache.rebuild();
            showStatusMessage('$(check) PHP Namespace Mover: Index rebuilt.');
        }),
    );

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { language: 'php', scheme: 'file' },
            new PhpCodeActionProvider(),
            { providedCodeActionKinds: PhpCodeActionProvider.providedCodeActionKinds }
        )
    );

    context.subscriptions.push(
        vscode.workspace.onWillSaveTextDocument(event => {
            if (!event || event.document.languageId !== 'php') { return; }

            const options = {
                remove: getConfig('removeOnSave'),
                add: getConfig('autoImportOnSave'),
                sort: getConfig('sortOnSave'),
            };
            if (!options.remove && !options.add && !options.sort) { return; }

            event.waitUntil(Promise.resolve(organizeImports.computeEdits(event.document, options)));
        }),

        vscode.commands.registerCommand('phpNamespaceMover.organizeImports', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'php') { return; }
            const edits = organizeImports.computeEdits(editor.document, { remove: true, add: true, sort: true });
            if (edits.length === 0) { showStatusMessage('$(check) Imports are already organized.'); return; }
            await editor.edit(builder => edits.forEach(e => builder.replace(e.range, e.newText)));
        }),

        vscode.languages.registerCodeActionsProvider(
            { language: 'php', scheme: 'file' },
            {
                provideCodeActions(document) {
                    const edits = organizeImports.computeEdits(document, { remove: true, add: true, sort: true });
                    if (edits.length === 0) { return []; }
                    const action = new vscode.CodeAction('Organize imports', vscode.CodeActionKind.SourceOrganizeImports);
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.set(document.uri, edits);
                    return [action];
                },
            },
            { providedCodeActionKinds: [vscode.CodeActionKind.SourceOrganizeImports] }
        )
    );

    context.subscriptions.push(cache, diagnosticManager, new MoveFiles(cache));
}

export function deactivate(): void {
    disposeStatusBar();
}
