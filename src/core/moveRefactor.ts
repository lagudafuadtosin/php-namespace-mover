import { analyzePhp, ImportStatement, PhpAnalysis } from './php/analysis';

/**
 * Plans the edits that keep code working after a PHP class file is moved or renamed:
 * the class's own namespace and name, every `use` import of it, every fully qualified
 * reference (code and PHPDoc), and files that used it without an import because they shared
 * its old namespace. Pure text in, edits out, so it is fully unit-tested.
 */

export interface TextChange {
    start: number;
    end: number;
    text: string;
}

export interface FileChanges {
    uri: string;
    changes: TextChange[];
}

export interface MoveInput {
    moved: { uri: string; text: string };
    newNamespace: string;
    newClassName: string;
    /** Short names of other classes in the moved class's old namespace (from the index). */
    oldNamespaceSiblings: Iterable<string>;
    /** Other PHP files that may refer to the class. */
    files: { uri: string; text: string }[];
}

export interface MovePlan {
    oldFqcn: string;
    newFqcn: string;
    files: FileChanges[];
}

const fq = (ns: string, name: string) => (ns ? `${ns}\\${name}` : name);
const same = (a: string, b: string) => a.replace(/^\\/, '').toLowerCase() === b.replace(/^\\/, '').toLowerCase();

export function planMove(input: MoveInput): MovePlan | null {
    const moved = analyzePhp(input.moved.text);
    const declaration = moved.declarations[0];
    if (!declaration) { return null; }

    const oldNamespace = moved.namespace?.name ?? '';
    const oldName = declaration.name;
    const oldFqcn = fq(oldNamespace, oldName);
    const newFqcn = fq(input.newNamespace, input.newClassName);
    if (same(oldFqcn, newFqcn)) { return null; }

    const renamed = oldName !== input.newClassName;
    const files: FileChanges[] = [];

    // The moved file itself
    const own: TextChange[] = [];
    if (moved.namespace && input.newNamespace && moved.namespace.name !== input.newNamespace) {
        own.push({ start: moved.namespace.nameStart, end: moved.namespace.nameEnd, text: input.newNamespace });
    }
    if (renamed) {
        own.push({ start: declaration.nameStart, end: declaration.nameStart + oldName.length, text: input.newClassName });
        // The class's references to itself (`new User`, `User::class`) follow the rename
        for (const u of moved.usages) {
            if (!u.qualified && u.kind !== 'namespacePrefix' && u.name === oldName) {
                own.push({ start: u.start, end: u.end, text: input.newClassName });
            }
        }
    }
    if (oldNamespace && oldNamespace !== input.newNamespace) {
        // Classes it used from its old namespace without an import now need one
        const siblings = new Set(input.oldNamespaceSiblings);
        const imported = new Set(importedNames(moved));
        const declared = new Set(moved.declarations.map(d => d.name));
        const needed = new Set<string>();
        for (const u of moved.usages) {
            if (u.qualified || u.kind === 'namespacePrefix') { continue; }
            if (siblings.has(u.name) && !imported.has(u.name) && !declared.has(u.name)) { needed.add(u.name); }
        }
        if (needed.size > 0) {
            own.push(insertImports(input.moved.text, moved, [...needed].sort().map(n => `use ${oldNamespace}\\${n};`)));
        }
    }
    if (input.newNamespace && !same(oldNamespace, input.newNamespace)) {
        // Imports of classes that live in the new namespace are no longer needed
        for (const statement of moved.imports) {
            if (statement.entries.length !== 1) { continue; }
            const entry = statement.entries[0];
            const entryNamespace = entry.fqcn.slice(0, Math.max(0, entry.fqcn.lastIndexOf('\\')));
            const short = entry.fqcn.slice(entry.fqcn.lastIndexOf('\\') + 1);
            if (entry.kind === 'class' && same(entryNamespace, input.newNamespace) && (entry.alias === null || entry.alias === short)) {
                const lineEnd = input.moved.text.indexOf('\n', statement.end);
                own.push({ start: statement.start, end: lineEnd === -1 ? statement.end : lineEnd + 1, text: '' });
            }
        }
    }
    if (own.length > 0) { files.push({ uri: input.moved.uri, changes: own }); }

    // Every other file
    for (const file of input.files) {
        if (file.uri === input.moved.uri) { continue; }
        if (!file.text.includes(oldName)) { continue; }
        const changes = planFile(file.text, oldNamespace, oldName, oldFqcn, input.newNamespace, input.newClassName, newFqcn);
        if (changes.length > 0) { files.push({ uri: file.uri, changes }); }
    }

    return { oldFqcn, newFqcn, files };
}

function planFile(
    text: string,
    oldNamespace: string,
    oldName: string,
    oldFqcn: string,
    newNamespace: string,
    newName: string,
    newFqcn: string
): TextChange[] {
    const analysis = analyzePhp(text);
    const changes: TextChange[] = [];
    const fileNamespace = analysis.namespace?.name ?? '';
    const renamed = oldName !== newName;

    // 1. `use` imports of the class
    let importedAs: string | null = null;
    for (const statement of analysis.imports) {
        const entry = statement.entries.find(e => e.kind === 'class' && same(e.fqcn, oldFqcn));
        if (!entry) { continue; }
        importedAs = entry.className;
        const redundant = same(fileNamespace, newNamespace) && statement.entries.length === 1
            && (entry.alias === null || entry.alias === newName);
        if (redundant) {
            // The class now lives in this file's own namespace: the import is no longer needed
            const lineEnd = text.indexOf('\n', statement.end);
            changes.push({ start: statement.start, end: lineEnd === -1 ? statement.end : lineEnd + 1, text: '' });
            continue;
        }
        changes.push(rewriteImport(text, statement, oldFqcn, newFqcn, entry.alias));
    }

    // 2. Files in the old namespace used it with no import at all
    const declaresOwn = analysis.declarations.some(d => d.name === oldName);
    const importsOtherWithName = analysis.imports.some(s => s.entries.some(e => e.kind === 'class' && e.className === oldName));
    const implicit = importedAs === null && !declaresOwn && !importsOtherWithName && same(fileNamespace, oldNamespace);
    const usedUnqualified = analysis.usages.some(u => !u.qualified && u.kind !== 'namespacePrefix' && u.name === oldName);
    if (implicit && usedUnqualified && !same(fileNamespace, newNamespace)) {
        changes.push(insertImports(text, analysis, [`use ${newFqcn};`]));
    }

    // 3. Short-name uses follow a rename when they refer to this class
    const shortRefersToClass = (importedAs !== null && importedAs === oldName) || (implicit && usedUnqualified);
    if (renamed && shortRefersToClass) {
        for (const u of analysis.usages) {
            if (!u.qualified && u.kind !== 'namespacePrefix' && u.name === oldName) {
                changes.push({ start: u.start, end: u.end, text: newName });
            }
        }
    }

    // 4. Fully qualified references, in code and PHPDoc
    const seen = new Set<number>();
    for (const u of analysis.usages) {
        if (!u.qualified || u.kind === 'namespacePrefix' || !same(u.written, oldFqcn)) { continue; }
        const writtenStart = u.end - u.written.length;
        if (seen.has(writtenStart)) { continue; }
        seen.add(writtenStart);
        const leading = u.written.startsWith('\\') ? '\\' : '';
        changes.push({ start: writtenStart, end: u.end, text: leading + newFqcn });
    }

    return changes;
}

/** Rewrites one `use` statement so its entry for `oldFqcn` points at `newFqcn`. */
function rewriteImport(text: string, statement: ImportStatement, oldFqcn: string, newFqcn: string, alias: string | null): TextChange {
    const original = text.slice(statement.start, statement.end);
    const open = original.indexOf('{');
    const aliasText = alias ? ` as ${alias}` : '';

    if (open === -1) {
        if (statement.entries.length === 1) {
            return { start: statement.start, end: statement.end, text: `use ${newFqcn}${aliasText};` };
        }
        // `use A, B;` - swap just this entry's path
        const pattern = new RegExp(`\\\\?${escape(oldFqcn)}(?![\\w\\\\])`, 'i');
        return { start: statement.start, end: statement.end, text: original.replace(pattern, newFqcn) };
    }

    // Grouped import `use Prefix\{A, B};`
    const prefix = original.slice(0, open).replace(/^use\s+/i, '').replace(/\\\s*$/, '').trim().replace(/^\\/, '');
    const close = original.lastIndexOf('}');
    const parts = original.slice(open + 1, close).split(',');
    const relativeOld = oldFqcn.slice(prefix.length + 1);
    const isOld = (p: string) => same(p.trim().replace(/\s+as\s+\w+$/i, ''), relativeOld);
    if (newFqcn.toLowerCase().startsWith(prefix.toLowerCase() + '\\')) {
        const relativeNew = newFqcn.slice(prefix.length + 1);
        const rewritten = parts.map(p => (isOld(p) ? ` ${relativeNew}${aliasText}` : p)).join(',');
        return { start: statement.start, end: statement.end, text: original.slice(0, open + 1) + rewritten.replace(/^ /, '') + original.slice(close) };
    }
    const kept = parts.filter(p => p.trim() && !isOld(p)).map(p => p.trim());
    const group = kept.length > 0 ? original.slice(0, open + 1) + kept.join(', ') + original.slice(close) + '\n' : '';
    return { start: statement.start, end: statement.end, text: `${group}use ${newFqcn}${aliasText};` };
}

/** An insertion of `use` lines after the last import, or after the namespace statement. */
function insertImports(text: string, analysis: PhpAnalysis, lines: string[]): TextChange {
    const block = lines.join('\n');
    const lastImport = analysis.imports.filter(s => !analysis.declarations[0] || s.start < analysis.declarations[0].start).pop();
    if (lastImport) {
        return { start: lastImport.end, end: lastImport.end, text: `\n${block}` };
    }
    if (analysis.namespace) {
        const semicolon = text.indexOf(';', analysis.namespace.nameEnd);
        const at = semicolon === -1 ? analysis.namespace.nameEnd : semicolon + 1;
        return { start: at, end: at, text: `\n\n${block}` };
    }
    const at = analysis.openTagEnd ?? 0;
    return { start: at, end: at, text: `\n\n${block}\n` };
}

function importedNames(analysis: PhpAnalysis): string[] {
    return analysis.imports.flatMap(s => s.entries.filter(e => e.kind === 'class').map(e => e.className));
}

function escape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Applies changes to text, last first, so offsets stay valid. Used by tests and previews. */
export function applyChanges(text: string, changes: TextChange[]): string {
    let out = text;
    for (const c of [...changes].sort((a, b) => b.start - a.start)) {
        out = out.slice(0, c.start) + c.text + out.slice(c.end);
    }
    return out;
}
