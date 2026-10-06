import { Token, tokenize, isSignificant } from './lexer';

/** Where in the code a class name was used. */
export type UsageKind =
    | 'extends' | 'implements' | 'enumImplements'
    | 'param' | 'return' | 'property' | 'constType'
    | 'new' | 'static' | 'instanceof' | 'catch'
    | 'attribute' | 'trait' | 'phpdoc'
    /** First segment of a relative qualified name, e.g. `Models` in `Models\User`. */
    | 'namespacePrefix';

export interface ClassUsage {
    /** Short name to import: the last segment, or the first segment for 'namespacePrefix'. */
    name: string;
    /** The name exactly as written. */
    written: string;
    kind: UsageKind;
    /** Offset of `name` in the text. */
    start: number;
    end: number;
    /** Written with a namespace part (`Foo\Bar` or `\Bar`), so it needs no import of its own. */
    qualified: boolean;
}

export interface ImportEntry {
    kind: 'class' | 'function' | 'const';
    fqcn: string;
    alias: string | null;
    /** The name the file uses: the alias, or the last segment. */
    className: string;
}

export interface ImportStatement {
    start: number;
    end: number;
    entries: ImportEntry[];
}

export interface Declaration {
    kind: 'class' | 'interface' | 'trait' | 'enum';
    name: string;
    start: number;
    nameStart: number;
}

export interface PhpAnalysis {
    tokens: Token[];
    usages: ClassUsage[];
    imports: ImportStatement[];
    /** `start`/`end` span the statement; `nameStart`/`nameEnd` the namespace name. */
    namespace: { name: string; start: number; end: number; nameStart: number; nameEnd: number } | null;
    declarations: Declaration[];
    declareStart: number | null;
    openTagEnd: number | null;
    templateParams: Set<string>;
}

const NON_CLASS_TYPES = new Set([
    'string', 'int', 'float', 'bool', 'array', 'object', 'null', 'void', 'never', 'mixed',
    'self', 'static', 'parent', 'true', 'false', 'iterable', 'callable', 'integer', 'boolean',
    'double', 'resource', 'number', 'scalar', 'numeric',
]);

const STATEMENT_STARTERS = new Set([
    'class', 'interface', 'trait', 'enum', 'abstract', 'final', 'readonly', 'function',
    'namespace', 'use', 'return', 'if', 'echo',
]);

const MODIFIERS = new Set(['public', 'protected', 'private', 'var', 'static', 'readonly', 'abstract', 'final']);

let lastText: string | null = null;
let lastAnalysis: PhpAnalysis | null = null;

/** Analyses PHP source once. The last result is reused while the text is unchanged. */
export function analyzePhp(text: string): PhpAnalysis {
    if (text === lastText && lastAnalysis) { return lastAnalysis; }
    const analysis = new Analyzer(text).run();
    lastText = text;
    lastAnalysis = analysis;
    return analysis;
}

export function isClassLikeName(shortName: string): boolean {
    return /^[A-Z]/.test(shortName) && !NON_CLASS_TYPES.has(shortName.toLowerCase());
}

type Frame = 'class' | 'function' | 'namespace' | 'block';

class Analyzer {
    private readonly tokens: Token[];
    private readonly sig: Token[];
    private readonly usages: ClassUsage[] = [];
    private readonly imports: ImportStatement[] = [];
    private readonly declarations: Declaration[] = [];
    private readonly templateParams = new Set<string>();
    private namespace: PhpAnalysis['namespace'] = null;
    private declareStart: number | null = null;
    private openTagEnd: number | null = null;
    private readonly stack: Frame[] = [];
    private pendingFrame: Frame | null = null;

    constructor(private readonly text: string) {
        this.tokens = tokenize(text);
        this.sig = this.tokens.filter(isSignificant);
    }

    run(): PhpAnalysis {
        for (const t of this.tokens) {
            if (t.kind === 'open' && this.openTagEnd === null) { this.openTagEnd = t.end; }
            if (t.kind === 'doc') { this.readDocBlock(t); }
        }

        const sig = this.sig;
        for (let i = 0; i < sig.length; i++) {
            const t = sig[i];

            if (t.kind === 'punct') {
                if (t.text === '{') {
                    this.stack.push(this.pendingFrame ?? 'block');
                    this.pendingFrame = null;
                } else if (t.text === '}') {
                    this.stack.pop();
                } else if (t.text === '#[') {
                    this.readAttributes(i);
                } else if (t.text === ';') {
                    if (this.pendingFrame === 'function') { this.pendingFrame = null; }
                }
                continue;
            }
            if (t.kind !== 'name') { continue; }

            const word = t.text.toLowerCase();
            const prev = sig[i - 1];
            const next = sig[i + 1];
            const afterArrow = prev !== undefined && (prev.text === '->' || prev.text === '?->' || prev.text === '::');

            if (next && next.text === '::' && !afterArrow) {
                this.addName(t, 'static');
                continue;
            }
            if (afterArrow) { continue; }

            if ((this.top() === 'class' || this.top() === undefined) && this.isMemberStart(i) && (MODIFIERS.has(word) || word === 'const')) {
                i = this.readMember(i);
                continue;
            }

            switch (word) {
                case 'namespace':
                    if (next && (next.kind === 'name' || next.text === '{')) { i = this.readNamespace(i); }
                    break;
                case 'use':
                    i = this.readUse(i);
                    break;
                case 'class': case 'interface': case 'trait': case 'enum': {
                    const nextWord = next?.text.toLowerCase();
                    if (word === 'class' && (nextWord === 'extends' || nextWord === 'implements' || nextWord === '(' || nextWord === '{')) {
                        // Anonymous class whose `new` came before attributes: `new #[Layout] class extends X {}`
                        let j = i + 1;
                        if (sig[j]?.text === '(') { j = this.matching(j) + 1; }
                        i = this.readHeaderTail(j, false);
                    } else if (next && next.kind === 'name' && (word !== 'enum' || this.looksLikeEnum(i))) {
                        i = this.readClassHeader(i);
                    }
                    break;
                }
                case 'function': case 'fn':
                    i = this.readFunction(i);
                    break;
                case 'set':
                    if (next && next.text === '(' && this.inPropertyHook(i)) { i = this.readFunction(i); }
                    break;
                case 'new':
                    i = this.readNew(i);
                    break;
                case 'instanceof':
                    if (next && next.kind === 'name') { this.addName(next, 'instanceof'); i++; }
                    break;
                case 'catch':
                    i = this.readCatch(i);
                    break;
                case 'declare':
                    if (this.declareStart === null) { this.declareStart = t.start; }
                    break;
                default:
                    if (t.text.includes('\\') && !t.text.startsWith('\\')) {
                        this.addNamespacePrefix(t);
                    }
            }
        }

        return {
            tokens: this.tokens,
            usages: this.usages,
            imports: this.imports,
            namespace: this.namespace,
            declarations: this.declarations,
            declareStart: this.declareStart,
            openTagEnd: this.openTagEnd,
            templateParams: this.templateParams,
        };
    }

    // ---- recording ------------------------------------------------------------------------

    private addName(t: Token, kind: UsageKind): void {
        this.addWritten(t.text, t.start, kind);
    }

    private addWritten(written: string, start: number, kind: UsageKind): void {
        const lower = written.toLowerCase();
        if (lower.startsWith('namespace\\')) { return; }
        const qualified = written.includes('\\');
        const short = written.slice(written.lastIndexOf('\\') + 1);
        if (!isClassLikeName(short)) { return; }
        const shortStart = start + written.length - short.length;
        this.usages.push({ name: short, written, kind, start: shortStart, end: shortStart + short.length, qualified });
        if (qualified && !written.startsWith('\\')) {
            const first = written.slice(0, written.indexOf('\\'));
            this.usages.push({ name: first, written, kind: 'namespacePrefix', start, end: start + first.length, qualified: false });
        }
    }

    private addNamespacePrefix(t: Token): void {
        const first = t.text.slice(0, t.text.indexOf('\\'));
        if (first.toLowerCase() === 'namespace') { return; }
        this.usages.push({ name: first, written: t.text, kind: 'namespacePrefix', start: t.start, end: t.start + first.length, qualified: false });
    }

    // ---- helpers --------------------------------------------------------------------------

    private top(): Frame | undefined {
        return this.stack[this.stack.length - 1];
    }

    private isMemberStart(i: number): boolean {
        const prev = this.sig[i - 1];
        return !prev || prev.text === '{' || prev.text === ';' || prev.text === '}' || prev.text === ']';
    }

    private inPropertyHook(i: number): boolean {
        const prev = this.sig[i - 1];
        // A property hook sits in a `{ }` block directly inside a class body. Bare snippets
        // (no class around them) are read the same way.
        const outer = this.stack.length >= 2 ? this.stack[this.stack.length - 2] : undefined;
        return (outer === 'class' || outer === undefined)
            && (!prev || prev.text === '{' || prev.text === ';' || prev.text === '}');
    }

    private looksLikeEnum(i: number): boolean {
        const after = this.sig[i + 2];
        return !after || after.text === '{' || after.text === ':' || after.text.toLowerCase() === 'implements';
    }

    /** Index of the token that closes the bracket opened at `open`, or the last index. */
    private matching(open: number): number {
        const opener = this.sig[open].text;
        const closer = opener === '(' ? ')' : opener === '[' || opener === '#[' ? ']' : '}';
        let depth = 0;
        for (let j = open; j < this.sig.length; j++) {
            const s = this.sig[j].text;
            if (s === '(' || s === '[' || s === '{' || s === '#[') {
                if (s === opener || (opener === '#[' && s === '[')) { depth++; }
            }
            if (s === closer) {
                depth--;
                if (depth === 0) { return j; }
            }
        }
        return this.sig.length - 1;
    }

    /** Records class names in a type such as `?Foo`, `A|B`, `(A&B)|null` from `from` until a stop token. */
    private readType(from: number, kind: UsageKind, stop: (t: Token) => boolean): number {
        let j = from;
        for (; j < this.sig.length; j++) {
            const t = this.sig[j];
            if (stop(t)) { break; }
            if (t.kind === 'name') { this.addName(t, kind); continue; }
            if (t.kind === 'punct' && ['?', '|', '&', '(', ')'].includes(t.text)) { continue; }
            break;
        }
        return j;
    }

    // ---- statements -----------------------------------------------------------------------

    private readNamespace(i: number): number {
        const sig = this.sig;
        let j = i + 1;
        let name = '';
        if (sig[j]?.kind === 'name') { name = sig[j].text; j++; }
        if (this.namespace === null && name) {
            this.namespace = { name, start: sig[i].start, end: sig[j]?.end ?? sig[j - 1].end, nameStart: sig[i + 1].start, nameEnd: sig[i + 1].end };
        }
        if (sig[j]?.text === '{') { this.pendingFrame = 'namespace'; return j - 1; }
        return j;
    }

    private readUse(i: number): number {
        const sig = this.sig;
        const prev = sig[i - 1];
        const next = sig[i + 1];
        if (!next || next.text === '(' || prev?.text === ')') { return i; }

        if (this.top() === 'class') {
            let j = i + 1;
            for (; j < sig.length; j++) {
                const t = sig[j];
                if (t.text === ';' || t.text === '{') { break; }
                if (t.kind === 'name') { this.addName(t, 'trait'); }
            }
            return sig[j]?.text === '{' ? j - 1 : j;
        }
        if (this.top() === 'function' || this.top() === 'block') { return i; }

        const statement: ImportStatement = { start: sig[i].start, end: sig[i].end, entries: [] };
        let j = i + 1;
        let kind: ImportEntry['kind'] = 'class';
        const lowerNext = next.text.toLowerCase();
        if (lowerNext === 'function' || lowerNext === 'const') { kind = lowerNext; j++; }

        // The statement runs to `;`. Grouped imports (`Prefix\{A, B}`) stay inside it, so their
        // braces never reach the main pass. An unfinished statement (no `;` before the next
        // declaration, as while typing) is not an import yet.
        let group = 0;
        for (; j < sig.length && sig[j].text !== ';'; j++) {
            const s = sig[j].text;
            if (s === '{') { group++; }
            else if (s === '}') { group--; }
            else if (group === 0 && sig[j].kind === 'name' && STATEMENT_STARTERS.has(s.toLowerCase())) { return i; }
        }
        if (j >= sig.length) { return i; }
        statement.end = sig[j].end;
        statement.entries = parseUseEntries(this.text.slice(sig[i].start, statement.end), kind);
        this.imports.push(statement);
        return j;
    }

    private readClassHeader(i: number): number {
        const sig = this.sig;
        const keyword = sig[i].text.toLowerCase() as Declaration['kind'];
        this.declarations.push({ kind: keyword, name: sig[i + 1].text, start: sig[i].start, nameStart: sig[i + 1].start });
        return this.readHeaderTail(i + 2, keyword === 'enum');
    }

    /** Reads `extends ...`, `implements ...` and an enum's `: type` up to the class body. */
    private readHeaderTail(from: number, isEnum: boolean): number {
        const sig = this.sig;
        let j = from;
        let mode: UsageKind | null = null;
        for (; j < sig.length; j++) {
            const t = sig[j];
            if (t.text === '{') {
                this.pendingFrame = 'class';
                return j - 1;
            }
            if (t.text === ';') { return j; }
            const lower = t.text.toLowerCase();
            if (t.kind === 'name' && lower === 'extends') { mode = 'extends'; continue; }
            if (t.kind === 'name' && lower === 'implements') { mode = isEnum ? 'enumImplements' : 'implements'; continue; }
            if (t.text === ':' && isEnum) { j++; continue; }
            if (t.kind === 'name' && mode) { this.addName(t, mode); }
        }
        return j;
    }

    private readFunction(i: number): number {
        const sig = this.sig;
        let j = i + 1;
        if (sig[j]?.text === '&') { j++; }
        if (sig[j]?.kind === 'name' && sig[j + 1]?.text === '(') { j++; }
        if (sig[j]?.text !== '(') { return i; }

        const close = this.matching(j);
        this.readParameters(j + 1, close);
        j = close + 1;

        if (sig[j]?.kind === 'name' && sig[j].text.toLowerCase() === 'use' && sig[j + 1]?.text === '(') {
            j = this.matching(j + 1) + 1;
        }
        if (sig[j]?.text === ':') {
            j = this.readType(j + 1, 'return', t => t.text === '{' || t.text === ';' || t.text === '=>');
        }
        if (sig[j]?.text === '{') {
            this.pendingFrame = 'function';
            return j - 1;
        }
        return j - 1;
    }

    /** Reads a parameter list between `from` and `close` (exclusive). */
    private readParameters(from: number, close: number): void {
        const sig = this.sig;
        let j = from;
        while (j < close) {
            // Attributes before the parameter
            while (sig[j]?.text === '#[') {
                const end = this.matching(j);
                this.readAttributes(j);
                j = end + 1;
            }
            let promoted = false;
            while (j < close && sig[j].kind === 'name' && MODIFIERS.has(sig[j].text.toLowerCase())) {
                promoted = true;
                j++;
                if (sig[j]?.text === '(' && sig[j + 1]?.text.toLowerCase() === 'set' && sig[j + 2]?.text === ')') { j += 3; }
            }
            const typeStart = j;
            j = this.readType(j, 'param', t => t.kind === 'var' || t.text === ',');
            if (promoted) {
                for (let k = typeStart; k < j; k++) {
                    if (sig[k].kind === 'name') { this.addName(sig[k], 'property'); }
                }
            }
            // Skip the variable and any default value up to the next parameter
            let depth = 0;
            for (; j < close; j++) {
                const s = sig[j].text;
                if (s === '(' || s === '[' || s === '{') { depth++; }
                else if (s === ')' || s === ']' || s === '}') { depth--; }
                else if (s === ',' && depth === 0) { j++; break; }
                else if (s === '#[') { depth++; }
                if (sig[j].kind === 'name' && sig[j].text.toLowerCase() === 'new' && sig[j + 1]?.kind === 'name') {
                    this.addName(sig[j + 1], 'new');
                }
                if (sig[j].kind === 'name' && sig[j + 1]?.text === '::') {
                    this.addName(sig[j], 'static');
                }
            }
        }
    }

    /** A class member starting with modifiers: a typed property, a typed constant, or a method. */
    private readMember(i: number): number {
        const sig = this.sig;
        let j = i;
        while (j < sig.length && sig[j].kind === 'name' && MODIFIERS.has(sig[j].text.toLowerCase())) {
            j++;
            if (sig[j]?.text === '(' && sig[j + 1]?.text.toLowerCase() === 'set' && sig[j + 2]?.text === ')') { j += 3; }
        }
        const word = sig[j]?.text.toLowerCase();
        if (word === 'function' || word === 'fn' || word === 'class' || word === 'interface' || word === 'trait' || word === 'enum') {
            return j - 1;
        }
        if (word === 'const') {
            // `const Type NAME = ...`: everything before the last name is the type
            let k = j + 1;
            const names: Token[] = [];
            for (; k < sig.length && sig[k].text !== '='; k++) {
                if (sig[k].text === ';') { break; }
                if (sig[k].kind === 'name') { names.push(sig[k]); }
            }
            for (const t of names.slice(0, -1)) { this.addName(t, 'constType'); }
            return j;
        }
        if (word === 'case') { return j; }
        if (j > i) {
            return this.readType(j, 'property', t => t.kind === 'var') - 1;
        }
        return i;
    }

    private readNew(i: number): number {
        const sig = this.sig;
        const next = sig[i + 1];
        if (!next) { return i; }
        if (next.text === '#[') {
            // `new #[Attr] class ...`: leave the attributes and the anonymous class to the main pass
            return i;
        }
        if (next.kind === 'name' && next.text.toLowerCase() === 'class') {
            let j = i + 2;
            if (sig[j]?.text === '(') { j = this.matching(j) + 1; }
            return this.readHeaderTail(j, false);
        }
        if (next.kind === 'name') {
            this.addName(next, 'new');
            return i + 1;
        }
        return i;
    }

    private readCatch(i: number): number {
        const sig = this.sig;
        if (sig[i + 1]?.text !== '(') { return i; }
        let j = i + 2;
        for (; j < sig.length; j++) {
            const t = sig[j];
            if (t.kind === 'var' || t.text === ')') { break; }
            if (t.kind === 'name') { this.addName(t, 'catch'); }
        }
        return j;
    }

    /** Records attribute names in a `#[...]` block. Arguments are left to the main pass. */
    private readAttributes(open: number): void {
        const sig = this.sig;
        const close = this.matching(open);
        let expectName = true;
        let depth = 0;
        for (let j = open + 1; j < close; j++) {
            const s = sig[j].text;
            if (s === '(' || s === '[' || s === '{') { depth++; continue; }
            if (s === ')' || s === ']' || s === '}') { depth--; continue; }
            if (depth === 0 && s === ',') { expectName = true; continue; }
            if (depth === 0 && expectName && sig[j].kind === 'name') {
                this.addName(sig[j], 'attribute');
                expectName = false;
            }
        }
    }

    // ---- PHPDoc ---------------------------------------------------------------------------

    private readDocBlock(doc: Token): void {
        const body = doc.text;
        const tagRe = /@([a-z][a-z-]*)[ \t]+/gi;
        let m: RegExpExecArray | null;
        while ((m = tagRe.exec(body)) !== null) {
            const tag = m[1].toLowerCase();
            const at = m.index + m[0].length;
            if (tag === 'template' || tag === 'psalm-template' || tag === 'phpstan-template') {
                const nameMatch = /^(\w+)(?:[ \t]+of[ \t]+)?/.exec(body.slice(at));
                if (nameMatch) {
                    this.templateParams.add(nameMatch[1]);
                    if (nameMatch[0].length > nameMatch[1].length) {
                        this.readDocType(doc, at + nameMatch[0].length);
                    }
                }
                continue;
            }
            if (DOC_TYPE_TAGS.has(tag)) {
                this.readDocType(doc, at);
                continue;
            }
            if (tag === 'method') {
                let k = at;
                const staticMatch = /^static[ \t]+/.exec(body.slice(k));
                if (staticMatch) { k += staticMatch[0].length; }
                const end = this.readDocType(doc, k);
                const rest = body.slice(end);
                const sigMatch = /^[ \t]*\w+[ \t]*\(([^)\n]*)\)/.exec(rest);
                if (sigMatch) {
                    let p = end + rest.indexOf('(') + 1;
                    for (const param of sigMatch[1].split(',')) {
                        const lead = param.length - param.trimStart().length;
                        this.readDocType(doc, p + lead);
                        p += param.length + 1;
                    }
                }
            }
        }
    }

    /** Reads one PHPDoc type expression at `at` and records its class names. Returns where it ended. */
    private readDocType(doc: Token, at: number): number {
        const body = doc.text;
        let depth = 0;
        let k = at;
        for (; k < body.length; k++) {
            const c = body[k];
            if (c === '<' || c === '(' || c === '{' || c === '[') { depth++; }
            else if (c === '>' || c === ')' || c === '}' || c === ']') {
                if (depth === 0) { break; }
                depth--;
            } else if (depth === 0 && (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '$')) {
                break;
            } else if (c === '*' && body[k + 1] === '/') {
                break;
            }
        }
        const expr = body.slice(at, k);
        const nameRe = /\\?[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*/g;
        let m: RegExpExecArray | null;
        while ((m = nameRe.exec(expr)) !== null) {
            const before = expr[m.index - 1];
            if (before === '$' || before === ':' && expr[m.index - 2] === ':') { continue; }
            // Skip array shape keys like `array{name: string}`
            if (expr[m.index + m[0].length] === ':' && expr[m.index + m[0].length + 1] !== ':') { continue; }
            this.addWritten(m[0], doc.start + at + m.index, 'phpdoc');
        }
        return k;
    }
}

const DOC_TYPE_TAGS = new Set([
    'param', 'var', 'property', 'property-read', 'property-write', 'return', 'throws',
    'psalm-param', 'phpstan-param', 'psalm-var', 'phpstan-var', 'psalm-return', 'phpstan-return',
    'mixin', 'see', 'extends', 'implements', 'template-extends', 'template-implements',
    'phpstan-extends', 'phpstan-implements', 'psalm-extends', 'psalm-implements', 'use',
]);

/** Parses the entries of one `use ...;` statement, including grouped imports. */
export function parseUseEntries(statement: string, kind: ImportEntry['kind']): ImportEntry[] {
    const body = statement.replace(/^use\s+(?:function\s+|const\s+)?/i, '').replace(/;\s*$/, '').trim();
    const entries: ImportEntry[] = [];
    const group = /^(.*?)\\?\{([\s\S]*)\}$/.exec(body);
    const toEntry = (path: string, defaultKind: ImportEntry['kind']): ImportEntry | null => {
        let p = path.trim();
        if (!p) { return null; }
        let k = defaultKind;
        const kindMatch = /^(function|const)\s+/i.exec(p);
        if (kindMatch) { k = kindMatch[1].toLowerCase() as ImportEntry['kind']; p = p.slice(kindMatch[0].length); }
        const aliasMatch = /^(.+?)\s+as\s+(\w+)$/i.exec(p);
        const fqcn = (aliasMatch ? aliasMatch[1] : p).trim().replace(/^\\/, '');
        const alias = aliasMatch ? aliasMatch[2] : null;
        const className = alias ?? fqcn.slice(fqcn.lastIndexOf('\\') + 1);
        return { kind: k, fqcn, alias, className };
    };
    if (group) {
        const prefix = group[1].trim().replace(/\\$/, '');
        for (const part of group[2].split(',')) {
            const e = toEntry(part, kind);
            if (e) { e.fqcn = `${prefix}\\${e.fqcn}`; entries.push(e); }
        }
    } else {
        for (const part of body.split(',')) {
            const e = toEntry(part, kind);
            if (e) { entries.push(e); }
        }
    }
    return entries;
}

/**
 * The classes, interfaces, traits and enums a file declares, with their full names. A quick
 * pass for indexing: it follows `namespace X;` and `namespace X { }` (several per file) and
 * ignores anything in comments, strings and heredocs.
 */
export function declaredClasses(text: string): { fqcn: string; className: string }[] {
    const sig = tokenize(text).filter(isSignificant);
    const out: { fqcn: string; className: string }[] = [];
    let namespace = '';
    for (let i = 0; i < sig.length; i++) {
        const t = sig[i];
        if (t.kind !== 'name') { continue; }
        const word = t.text.toLowerCase();
        const prev = sig[i - 1]?.text;
        if (prev === '::' || prev === '->' || prev === '?->') { continue; }
        if (word === 'namespace') {
            const next = sig[i + 1];
            if (next?.kind === 'name') { namespace = next.text.replace(/^\\/, ''); i++; }
            else if (next?.text === '{') { namespace = ''; }
            continue;
        }
        if ((word === 'class' || word === 'interface' || word === 'trait' || word === 'enum') && prev?.toLowerCase() !== 'new') {
            const name = sig[i + 1];
            if (name?.kind !== 'name' || name.text.includes('\\')) { continue; }
            const lower = name.text.toLowerCase();
            if (lower === 'extends' || lower === 'implements') { continue; }
            if (word === 'enum') {
                const after = sig[i + 2]?.text.toLowerCase();
                if (after !== undefined && after !== '{' && after !== ':' && after !== 'implements') { continue; }
            }
            out.push({ fqcn: namespace ? `${namespace}\\${name.text}` : name.text, className: name.text });
            i++;
        }
    }
    return out;
}
