import { DetectedClass } from '../types';
import { analyzePhp, ClassUsage, UsageKind } from './php/analysis';
import { tokenize } from './php/lexer';

/**
 * Blanks out strings, heredocs and all comments (PHPDoc included), keeping every newline and
 * the exact length so offsets still line up with the original text.
 */
export function sanitizePhpCode(text: string): string {
    return blank(text, kind => kind === 'string' || kind === 'heredoc' || kind === 'comment' || kind === 'doc');
}

/** Like sanitizePhpCode but keeps PHPDoc blocks, where `@tag` types still count as usage. */
export function sanitizeForDiagnostics(text: string): string {
    return blank(text, kind => kind === 'string' || kind === 'heredoc' || kind === 'comment');
}

function blank(text: string, shouldBlank: (kind: string) => boolean): string {
    let out = '';
    for (const t of tokenize(text)) {
        out += shouldBlank(t.kind) ? t.text.replace(/[^\r\n]/g, ' ') : t.text;
    }
    return out;
}

/**
 * Finds the class names a PHP file uses, and where. Everything comes from one tokenized pass
 * (see ./php/analysis), so strings, comments and inline HTML can never produce false matches,
 * and no pattern can backtrack on long or unfinished lines.
 */
export class PhpClassDetector {
    /** Unique short class names used without a namespace part somewhere in the file. */
    detectAll(text: string): string[] {
        const analysis = analyzePhp(text);
        const names = new Set<string>();
        for (const u of this.classUsages(text)) {
            if (!u.qualified) { names.add(u.name); }
        }
        for (const t of analysis.templateParams) { names.delete(t); }
        return [...names];
    }

    /** Every place a class name is used without a namespace part, one entry per position. */
    detectAllWithPositions(text: string): DetectedClass[] {
        const analysis = analyzePhp(text);
        const seen = new Set<number>();
        const results: DetectedClass[] = [];
        const lineStarts = computeLineStarts(text);
        for (const u of this.classUsages(text)) {
            if (u.qualified || seen.has(u.start) || analysis.templateParams.has(u.name)) { continue; }
            seen.add(u.start);
            const pos = offsetToPosition(lineStarts, u.start);
            results.push({ name: u.name, offset: u.start, line: pos.line, character: pos.character });
        }
        return results.sort((a, b) => a.offset - b.offset);
    }

    /**
     * Names that keep an import in use: short class names, plus the first segment of relative
     * qualified names such as `Models` in `new Models\User` (which uses `use App\Models;`).
     */
    namesUsedByCode(text: string): Set<string> {
        const names = new Set<string>();
        for (const u of analyzePhp(text).usages) {
            if (!u.qualified) { names.add(u.name); }
        }
        return names;
    }

    getExtended(text: string): string[] { return this.of(text, 'extends'); }
    getImplemented(text: string): string[] { return this.of(text, 'implements', 'enumImplements'); }
    getFromFunctionParameters(text: string): string[] { return this.of(text, 'param'); }
    getReturnTypes(text: string): string[] { return this.of(text, 'return'); }
    getPropertyTypes(text: string): string[] { return this.of(text, 'property'); }
    getInitializedWithNew(text: string): string[] { return this.of(text, 'new'); }
    getFromStaticCalls(text: string): string[] { return this.of(text, 'static'); }
    getFromInstanceof(text: string): string[] { return this.of(text, 'instanceof'); }
    getFromCatchBlocks(text: string): string[] { return this.of(text, 'catch'); }
    getFromAttributes(text: string): string[] { return this.of(text, 'attribute'); }
    getEnumImplements(text: string): string[] { return this.of(text, 'enumImplements'); }
    getFromTypedConstants(text: string): string[] { return this.of(text, 'constType'); }
    getFromTraitUse(text: string): string[] { return this.of(text, 'trait'); }

    getFromPhpDoc(text: string): string[] {
        const templates = analyzePhp(text).templateParams;
        return this.of(text, 'phpdoc').filter(name => !templates.has(name));
    }

    private classUsages(text: string): ClassUsage[] {
        return analyzePhp(text).usages.filter(u => u.kind !== 'namespacePrefix');
    }

    private of(text: string, ...kinds: UsageKind[]): string[] {
        return analyzePhp(text).usages
            .filter(u => kinds.includes(u.kind))
            .sort((a, b) => a.start - b.start)
            .map(u => u.name);
    }
}

function computeLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) { starts.push(i + 1); }
    }
    return starts;
}

function offsetToPosition(lineStarts: number[], offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) { lo = mid; } else { hi = mid - 1; }
    }
    return { line: lo, character: offset - lineStarts[lo] };
}
