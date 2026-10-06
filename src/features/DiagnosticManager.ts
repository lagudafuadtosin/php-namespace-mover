import * as vscode from 'vscode';
import { PhpClassDetector } from '../core/PhpClassDetector';
import { DeclarationParser } from '../core/DeclarationParser';
import { NamespaceCache } from '../core/NamespaceCache';
import { DiagnosticCode, UseStatement } from '../types';
import { builtInClasses } from '../data/builtInClasses';
import { getConfig } from '../utils/config';

const DIAGNOSTIC_SOURCE = 'PHP Namespace Mover';

/**
 * Warns about classes used without an import and imports that are never used. Positions come
 * straight from the tokenized analysis, so a warning always sits on a real use of the class,
 * never on a word inside a string, a comment or inline HTML.
 */
export class DiagnosticManager implements vscode.Disposable {
    private collection: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];
    private lastVersion = new Map<string, number>();

    constructor(
        private detector: PhpClassDetector,
        private parser: DeclarationParser,
        private cache: NamespaceCache
    ) {
        this.collection = vscode.languages.createDiagnosticCollection('phpNamespaceMover');

        this.disposables.push(
            cache.onDidFinishIndexing(() => this.refreshVisible()),
            vscode.workspace.onDidSaveTextDocument(document => {
                if (document.languageId !== 'php') { return; }
                this.update(document);
            }),
            vscode.workspace.onDidCloseTextDocument(document => {
                this.clear(document.uri);
            })
        );
    }

    refreshVisible(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId === 'php') {
                this.update(editor.document);
            }
        }
    }

    update(document: vscode.TextDocument): void {
        if (document.languageId !== 'php') {
            this.collection.delete(document.uri);
            return;
        }

        // Skip if document hasn't changed since last update
        const key = document.uri.toString();
        const version = document.version;
        if (this.lastVersion.get(key) === version) { return; }
        this.lastVersion.set(key, version);

        const text = document.getText();
        const ignoreList = getConfig('ignoreList');
        const { useStatements } = this.parser.parse(document);
        const classUseStatements = useStatements.filter(s => s.kind === 'class');

        const diagnostics: vscode.Diagnostic[] = [];

        if (this.cache.indexed && getConfig('highlightNotImported')) {
            diagnostics.push(...this.getNotImportedDiagnostics(document, text, classUseStatements, ignoreList));
        }
        if (getConfig('highlightNotUsed')) {
            const filtered = classUseStatements.filter(s => !ignoreList.includes(s.className));
            diagnostics.push(...this.getNotUsedDiagnostics(document, text, filtered));
        }

        this.collection.set(document.uri, diagnostics);
    }

    getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
        return this.collection.get(uri) ?? [];
    }

    clear(uri: vscode.Uri): void {
        this.collection.delete(uri);
        this.lastVersion.delete(uri.toString());
    }

    clearAll(): void {
        this.collection.clear();
        this.lastVersion.clear();
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.collection.dispose();
    }

    /**
     * True when the short name already resolves without an import: a class declared in the
     * current namespace or, in a file without a namespace, a global class (built in or from
     * the project).
     */
    private resolvesWithoutImport(className: string, currentNamespace: string | null): boolean {
        if (!currentNamespace) {
            if (builtInClasses.has(className)) { return true; }
            return this.cache.lookup(className).some(e => e.fqcn === className);
        }
        return this.cache.lookup(className).some(e => e.fqcn === `${currentNamespace}\\${className}`);
    }

    private getNotImportedDiagnostics(
        document: vscode.TextDocument,
        text: string,
        useStatements: UseStatement[],
        ignoreList: string[]
    ): vscode.Diagnostic[] {
        const imported = new Set(useStatements.map(s => s.className));
        const declared = new Set(this.parser.getDeclaredClassNames(document));
        const currentNamespace = this.parser.getNamespace(document);
        const verdicts = new Map<string, boolean>();
        const diagnostics: vscode.Diagnostic[] = [];

        for (const usage of this.detector.detectAllWithPositions(text)) {
            const className = usage.name;
            let missing = verdicts.get(className);
            if (missing === undefined) {
                missing = !imported.has(className)
                    && !declared.has(className)
                    && !ignoreList.includes(className)
                    && !this.resolvesWithoutImport(className, currentNamespace);
                verdicts.set(className, missing);
            }
            if (!missing) { continue; }

            const range = new vscode.Range(
                document.positionAt(usage.offset),
                document.positionAt(usage.offset + className.length)
            );
            const diag = new vscode.Diagnostic(
                range,
                `Class '${className}' is not imported.`,
                vscode.DiagnosticSeverity.Warning
            );
            diag.code = DiagnosticCode.ClassNotImported;
            diag.source = DIAGNOSTIC_SOURCE;
            diagnostics.push(diag);
        }

        return diagnostics;
    }

    private getNotUsedDiagnostics(
        document: vscode.TextDocument,
        text: string,
        useStatements: UseStatement[]
    ): vscode.Diagnostic[] {
        const used = this.detector.namesUsedByCode(text);
        const diagnostics: vscode.Diagnostic[] = [];

        for (const stmt of useStatements) {
            if (used.has(stmt.className)) { continue; }

            const range = this.rangeOfName(document, stmt);
            const diag = new vscode.Diagnostic(
                range,
                `Imported class '${stmt.className}' is not used.`,
                vscode.DiagnosticSeverity.Warning
            );
            diag.code = DiagnosticCode.ClassNotUsed;
            diag.source = DIAGNOSTIC_SOURCE;
            diag.tags = [vscode.DiagnosticTag.Unnecessary];
            diagnostics.push(diag);
        }

        return diagnostics;
    }

    /** The range of an import's name (the alias, or the last segment) inside its statement. */
    private rangeOfName(document: vscode.TextDocument, stmt: UseStatement): vscode.Range {
        const statementStart = document.offsetAt(new vscode.Position(stmt.line, 0));
        const statementText = document.getText().slice(statementStart, statementStart + stmt.text.length + 200);
        const wanted = stmt.alias ?? stmt.fqcn.slice(stmt.fqcn.lastIndexOf('\\') + 1);
        const pattern = new RegExp(`(?<![\\w\\\\$])${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w\\\\])`, 'g');
        let found = -1;
        let m: RegExpExecArray | null;
        const fqcnTail = stmt.fqcn.split('\\').slice(-1)[0];
        while ((m = pattern.exec(statementText)) !== null) {
            found = m.index;
            const after = statementText.slice(m.index + wanted.length).trimStart();
            if (stmt.alias || !after.toLowerCase().startsWith('as ')) {
                if (wanted === fqcnTail || stmt.alias) { break; }
            }
        }
        if (found === -1) {
            return new vscode.Range(stmt.line, 0, stmt.line, 0);
        }
        return new vscode.Range(
            document.positionAt(statementStart + found),
            document.positionAt(statementStart + found + wanted.length)
        );
    }
}
