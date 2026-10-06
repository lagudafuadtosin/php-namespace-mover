import * as vscode from 'vscode';
import { UseStatement, DeclarationLines, DeclarationResult, InsertPosition } from '../types';
import { getInsertPosition as computeInsertPosition } from './insertPosition';
import { analyzePhp, PhpAnalysis } from './php/analysis';

/**
 * Reads a file's header: the opening tag, `declare`, `namespace`, the `use` imports and the
 * first class-like declaration. Built on the tokenized analysis, so imports split over many
 * lines, grouped imports and comments between statements are all read correctly.
 */
export class DeclarationParser {
    /** If `pickedClass` is provided, throws if it's already imported. */
    parse(document: vscode.TextDocument, pickedClass?: string): DeclarationResult {
        const text = document.getText();
        const analysis = analyzePhp(text);
        const line = (offset: number) => document.positionAt(offset).line;

        const declarationLines: DeclarationLines = {
            phpTag: 0,
            declare: null,
            namespace: null,
            firstUseStatement: null,
            lastUseStatement: null,
            classDeclaration: null,
        };

        if (analysis.openTagEnd !== null) { declarationLines.phpTag = line(analysis.openTagEnd) + 1; }
        if (analysis.declareStart !== null) { declarationLines.declare = line(analysis.declareStart) + 1; }
        if (analysis.namespace) { declarationLines.namespace = line(analysis.namespace.start) + 1; }
        const firstDeclaration = analysis.declarations[0];
        if (firstDeclaration) { declarationLines.classDeclaration = line(firstDeclaration.start) + 1; }

        const useStatements: UseStatement[] = [];
        for (const statement of headerImports(analysis)) {
            const startLine = line(statement.start);
            const statementText = text.slice(statement.start, statement.end);
            for (const entry of statement.entries) {
                if (pickedClass !== undefined && pickedClass !== null && entry.fqcn === pickedClass) {
                    throw new Error('The class is already imported.');
                }
                useStatements.push({
                    text: statementText,
                    line: startLine,
                    fqcn: entry.fqcn,
                    alias: entry.alias,
                    className: entry.className,
                    kind: entry.kind,
                });
            }
            if (statement.entries.length > 0) {
                if (declarationLines.firstUseStatement === null) { declarationLines.firstUseStatement = startLine + 1; }
                declarationLines.lastUseStatement = line(statement.end) + 1;
            }
        }

        return { useStatements, declarationLines };
    }

    getInsertPosition(declarationLines: DeclarationLines): InsertPosition {
        return computeInsertPosition(declarationLines);
    }

    getImportedClassNames(document: vscode.TextDocument): string[] {
        const names: string[] = [];
        for (const statement of headerImports(analyzePhp(document.getText()))) {
            for (const entry of statement.entries) {
                if (entry.kind === 'class') { names.push(entry.className); }
            }
        }
        return names;
    }

    getNamespace(document: vscode.TextDocument): string | null {
        return analyzePhp(document.getText()).namespace?.name ?? null;
    }

    getDeclaredClassNames(document: vscode.TextDocument): string[] {
        return analyzePhp(document.getText()).declarations.map(d => d.name);
    }
}

/** Imports in the file header, before the first class, interface, trait or enum. */
function headerImports(analysis: PhpAnalysis) {
    const limit = analysis.declarations[0]?.start ?? Infinity;
    return analysis.imports.filter(s => s.start < limit);
}
