import * as vscode from 'vscode';
import { PhpClassDetector } from '../core/PhpClassDetector';
import { DeclarationParser } from '../core/DeclarationParser';
import { NamespaceCache } from '../core/NamespaceCache';
import { SortManager } from '../core/SortManager';
import { builtInClasses } from '../data/builtInClasses';
import { withoutEntries } from '../core/useStatementEdit';
import { UseStatement } from '../types';
import { getConfig } from '../utils/config';

export interface OrganizeOptions {
    remove: boolean;
    add: boolean;
    sort: boolean;
}

/**
 * Computes one edit that tidies a file's imports: drops unused ones, adds the missing ones
 * that have exactly one possible match, and sorts. Nothing here asks the user anything, so
 * it is safe to run on save; ambiguous classes are left for the Import command.
 */
export class OrganizeImports {
    constructor(
        private detector: PhpClassDetector,
        private parser: DeclarationParser,
        private cache: NamespaceCache,
        private sortManager: SortManager
    ) {}

    computeEdits(document: vscode.TextDocument, options: OrganizeOptions): vscode.TextEdit[] {
        const text = document.getText();
        const { useStatements, declarationLines } = this.parser.parse(document);
        const ignoreList = getConfig('ignoreList');

        // Keep each statement as one unit; grouped imports share a line and text
        const byLine = new Map<number, UseStatement[]>();
        for (const stmt of useStatements) {
            byLine.set(stmt.line, [...(byLine.get(stmt.line) ?? []), stmt]);
        }

        let changed = false;
        let kept: UseStatement[] = [];
        if (options.remove) {
            const used = this.detector.namesUsedByCode(text);
            for (const entries of byLine.values()) {
                const unused = entries.filter(s =>
                    s.kind === 'class' && !ignoreList.includes(s.className) && !used.has(s.className));
                if (unused.length === 0) { kept.push(...entries); continue; }
                changed = true;
                if (unused.length < entries.length) {
                    const rewritten = withoutEntries(entries[0].text, unused);
                    kept.push(...entries.filter(s => !unused.includes(s)).map(s => ({ ...s, text: rewritten })));
                }
            }
        } else {
            kept = [...useStatements];
        }

        if (options.add) {
            let syntheticLine = -1;
            for (const fqcn of this.missingImports(document, text, useStatements, ignoreList)) {
                kept.push({
                    text: `use ${fqcn};`,
                    line: syntheticLine--,
                    fqcn,
                    alias: null,
                    className: fqcn.slice(fqcn.lastIndexOf('\\') + 1),
                    kind: 'class',
                });
                changed = true;
            }
        }

        if (!changed && !options.sort) { return []; }

        if (useStatements.length === 0) {
            if (kept.length === 0) { return []; }
            const pos = this.parser.getInsertPosition(declarationLines);
            const block = this.render(kept, options.sort);
            return [vscode.TextEdit.insert(new vscode.Position(pos.line, 0), `${pos.prepend}${block}${pos.append}`)];
        }

        const firstLine = declarationLines.firstUseStatement! - 1;
        const lastLine = declarationLines.lastUseStatement! - 1;
        const range = new vscode.Range(firstLine, 0, lastLine, document.lineAt(lastLine).text.length);
        const block = this.render(kept, options.sort);
        if (block === document.getText(range)) { return []; }

        if (kept.length === 0) {
            // Every import was unused: remove the block and the blank line after it
            const end = lastLine + 1 < document.lineCount && document.lineAt(lastLine + 1).isEmptyOrWhitespace
                ? new vscode.Position(lastLine + 2, 0)
                : document.lineAt(lastLine).rangeIncludingLineBreak.end;
            return [vscode.TextEdit.delete(new vscode.Range(new vscode.Position(firstLine, 0), end))];
        }
        return [vscode.TextEdit.replace(range, block)];
    }

    /** Fully qualified names of used classes that are not imported and have exactly one match. */
    private missingImports(
        document: vscode.TextDocument,
        text: string,
        useStatements: UseStatement[],
        ignoreList: string[]
    ): string[] {
        const imported = new Set(useStatements.filter(s => s.kind === 'class').map(s => s.className));
        const declared = new Set(this.parser.getDeclaredClassNames(document));
        const namespace = this.parser.getNamespace(document);
        if (!namespace) { return []; }

        const result: string[] = [];
        for (const className of this.detector.detectAll(text)) {
            if (imported.has(className) || declared.has(className) || ignoreList.includes(className)) { continue; }
            const candidates = new Set(this.cache.lookup(className).map(e => e.fqcn));
            if (builtInClasses.has(className)) { candidates.add(className); }
            if (candidates.has(`${namespace}\\${className}`)) { continue; }
            if (candidates.size === 1) { result.push([...candidates][0]); }
        }
        return result;
    }

    private render(statements: UseStatement[], sort: boolean): string {
        if (sort) { return this.sortManager.renderSorted(statements); }
        const seen = new Set<string>();
        return statements.filter(s => {
            if (seen.has(s.text)) { return false; }
            seen.add(s.text);
            return true;
        }).map(s => s.text).join('\n');
    }
}
