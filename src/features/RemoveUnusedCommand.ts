import * as vscode from 'vscode';
import { PhpClassDetector } from '../core/PhpClassDetector';
import { DeclarationParser } from '../core/DeclarationParser';
import { requireActiveEditor } from '../utils/editor';
import { showStatusMessage } from '../utils/statusBar';
import { getConfig } from '../utils/config';
import { UseStatement } from '../types';
import { withoutEntries } from '../core/useStatementEdit';

export class RemoveUnusedCommand {
    constructor(
        private detector: PhpClassDetector,
        private parser: DeclarationParser
    ) {}

    async execute(): Promise<void> {
        try {
            const editor = requireActiveEditor();
            const removed = await this.removeUnused(editor);
            if (removed > 0) {
                showStatusMessage(`$(check) Removed ${removed} unused import${removed > 1 ? 's' : ''}.`);
            } else {
                showStatusMessage('$(check) No unused imports found.');
            }
        } catch (error: any) {
            showStatusMessage(error.message);
        }
    }

    async removeUnused(editor: vscode.TextEditor): Promise<number> {
        const document = editor.document;
        const used = this.detector.namesUsedByCode(document.getText());
        const { useStatements } = this.parser.parse(document);
        const ignoreList = getConfig('ignoreList');

        const isUnused = (stmt: UseStatement) =>
            stmt.kind === 'class' && !ignoreList.includes(stmt.className) && !used.has(stmt.className);

        // Entries of one statement (a grouped or comma-separated import) share its text and line
        const statements = new Map<number, UseStatement[]>();
        for (const stmt of useStatements) {
            statements.set(stmt.line, [...(statements.get(stmt.line) ?? []), stmt]);
        }

        let removed = 0;
        const edits: { range: vscode.Range; replacement: string }[] = [];
        for (const [line, entries] of statements) {
            const unused = entries.filter(isUnused);
            if (unused.length === 0) { continue; }
            removed += unused.length;

            const start = new vscode.Position(line, document.lineAt(line).firstNonWhitespaceCharacterIndex);
            const end = document.positionAt(document.offsetAt(start) + entries[0].text.length);
            if (unused.length === entries.length) {
                const lastLine = document.lineAt(end.line);
                edits.push({ range: new vscode.Range(new vscode.Position(line, 0), lastLine.rangeIncludingLineBreak.end), replacement: '' });
            } else {
                edits.push({ range: new vscode.Range(start, end), replacement: withoutEntries(entries[0].text, unused) });
            }
        }

        if (edits.length === 0) {
            return 0;
        }

        await editor.edit(textEdit => {
            for (const edit of edits.sort((a, b) => b.range.start.line - a.range.start.line)) {
                textEdit.replace(edit.range, edit.replacement);
            }
        });

        await this.cleanupBlankLines(editor);

        return removed;
    }

    private async cleanupBlankLines(editor: vscode.TextEditor): Promise<void> {
        const document = editor.document;
        const linesToDelete: number[] = [];

        let inUseArea = false;
        let prevBlank = false;

        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text.trim();

            if (text.startsWith('use ')) {
                inUseArea = true;
                prevBlank = false;
            } else if (inUseArea && text === '') {
                if (prevBlank) {
                    linesToDelete.push(line);
                }
                prevBlank = true;
            } else if (inUseArea && text !== '') {
                break;
            }
        }

        if (linesToDelete.length > 0) {
            await editor.edit(textEdit => {
                for (const line of linesToDelete.reverse()) {
                    textEdit.delete(document.lineAt(line).rangeIncludingLineBreak);
                }
            });
        }
    }
}

