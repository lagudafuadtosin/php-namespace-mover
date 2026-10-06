import * as vscode from 'vscode';
import { DeclarationParser } from './DeclarationParser';
import { findComposerJson, namespaceForFile } from './composerNamespace';
import { analyzePhp } from './php/analysis';
import { showStatusMessage } from '../utils/statusBar';

/** Writes the namespace composer.json's autoload gives the current file's folder. */
export class NamespaceGenerator {
    constructor(private parser: DeclarationParser) {}

    async generate(editor: vscode.TextEditor): Promise<void> {
        const document = editor.document;
        if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
            return void showStatusMessage('No folder opened in workspace, cannot find composer.json');
        }
        if (!(await findComposerJson(document.uri))) {
            return void showStatusMessage('No composer.json file found, automatic namespace generation failed');
        }

        const namespace = await namespaceForFile(document.uri);
        if (!namespace) {
            return void showStatusMessage('Could not resolve namespace from composer.json autoload configuration');
        }

        const analysis = analyzePhp(document.getText());
        if (analysis.namespace) {
            // Replace just the name, wherever the statement sits (even `<?php namespace X;`)
            const range = new vscode.Range(
                document.positionAt(analysis.namespace.nameStart),
                document.positionAt(analysis.namespace.nameEnd)
            );
            if (document.getText(range) !== namespace) {
                await editor.edit(textEdit => textEdit.replace(range, namespace));
            }
            return;
        }

        let declarationLines;
        try {
            ({ declarationLines } = this.parser.parse(document));
        } catch (error: any) {
            return void showStatusMessage(error.message);
        }
        const insertLine = declarationLines.declare ?? declarationLines.phpTag;
        await editor.edit(textEdit => {
            textEdit.insert(new vscode.Position(insertLine, 0), `\nnamespace ${namespace};\n`);
        });
    }
}
