/**
 * A small PHP lexer. It splits source text into tokens in one linear pass, so nothing
 * downstream ever needs a regular expression over a whole file. It knows enough PHP to
 * tell code apart from strings, comments, PHPDoc, heredocs and inline HTML, and to keep
 * qualified names such as `\Foo\Bar` or `Models\User` together as one token.
 */

export type TokenKind =
    | 'html'      // text outside <?php ... ?>
    | 'open'      // <?php or <?=
    | 'close'     // ?>
    | 'ws'        // whitespace
    | 'comment'   // // ..., # ..., /* ... */
    | 'doc'       // /** ... */
    | 'string'    // '...', "...", `...`
    | 'heredoc'   // <<<ID ... ID and nowdoc
    | 'var'       // $name
    | 'name'      // identifier or qualified name
    | 'number'
    | 'punct';

export interface Token {
    kind: TokenKind;
    text: string;
    start: number;
    end: number;
}

const MULTI_PUNCT = ['?->', '...', '<=>', '**=', '??=', '::', '->', '=>', '??', '#[', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '.=', '%=', '|=', '&=', '^=', '<<', '>>'];

function isNameStart(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code >= 128;
}

function isNameChar(code: number): boolean {
    return isNameStart(code) || (code >= 48 && code <= 57);
}

function isDigit(code: number): boolean {
    return code >= 48 && code <= 57;
}

function isSpace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

const OPEN_TAG = /<\?(?:php\b|=)/gi;

/**
 * Tokenizes PHP source. Text that holds an opening tag starts as inline HTML; a bare
 * snippet with no tag at all is read as PHP code.
 */
export function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    const n = text.length;
    let i = 0;
    OPEN_TAG.lastIndex = 0;
    let inPhp = !OPEN_TAG.test(text);

    const push = (kind: TokenKind, start: number, end: number) => {
        tokens.push({ kind, text: text.slice(start, end), start, end });
    };

    while (i < n) {
        if (!inPhp) {
            OPEN_TAG.lastIndex = i;
            const m = OPEN_TAG.exec(text);
            const htmlEnd = m ? m.index : n;
            if (htmlEnd > i) { push('html', i, htmlEnd); }
            if (!m) { break; }
            push('open', m.index, m.index + m[0].length);
            i = m.index + m[0].length;
            inPhp = true;
            continue;
        }

        const ch = text[i];
        const code = text.charCodeAt(i);

        if (isSpace(ch)) {
            let j = i + 1;
            while (j < n && isSpace(text[j])) { j++; }
            push('ws', i, j);
            i = j;
            continue;
        }

        if (ch === '?' && text[i + 1] === '>') {
            push('close', i, i + 2);
            i += 2;
            inPhp = false;
            continue;
        }

        if (ch === '/' && text[i + 1] === '*') {
            const endIdx = text.indexOf('*/', i + 2);
            const j = endIdx === -1 ? n : endIdx + 2;
            const isDoc = text[i + 2] === '*' && text[i + 3] !== '/';
            push(isDoc ? 'doc' : 'comment', i, j);
            i = j;
            continue;
        }

        if ((ch === '/' && text[i + 1] === '/') || (ch === '#' && text[i + 1] !== '[')) {
            // A line comment ends at the newline or at a closing ?> tag
            let j = i;
            while (j < n && text[j] !== '\n' && !(text[j] === '?' && text[j + 1] === '>')) { j++; }
            push('comment', i, j);
            i = j;
            continue;
        }

        if (ch === '\'' || ch === '"' || ch === '`') {
            let j = i + 1;
            while (j < n && text[j] !== ch) {
                if (text[j] === '\\') { j++; }
                j++;
            }
            j = Math.min(j + 1, n);
            push('string', i, j);
            i = j;
            continue;
        }

        if (ch === '<' && text.startsWith('<<<', i)) {
            const end = readHeredoc(text, i);
            if (end > i) {
                push('heredoc', i, end);
                i = end;
                continue;
            }
        }

        if (ch === '$' && i + 1 < n && (isNameStart(text.charCodeAt(i + 1)) || text[i + 1] === '$')) {
            let j = i + 1;
            while (j < n && text[j] === '$') { j++; }
            while (j < n && isNameChar(text.charCodeAt(j))) { j++; }
            push('var', i, j);
            i = j;
            continue;
        }

        if (isNameStart(code) || (ch === '\\' && i + 1 < n && isNameStart(text.charCodeAt(i + 1)))) {
            let j = i;
            if (text[j] === '\\') { j++; }
            for (;;) {
                while (j < n && isNameChar(text.charCodeAt(j))) { j++; }
                if (text[j] === '\\' && j + 1 < n && isNameStart(text.charCodeAt(j + 1))) {
                    j++;
                    continue;
                }
                break;
            }
            push('name', i, j);
            i = j;
            continue;
        }

        if (isDigit(code) || (ch === '.' && isDigit(text.charCodeAt(i + 1)))) {
            let j = i + 1;
            while (j < n && (isNameChar(text.charCodeAt(j)) || text[j] === '.')) {
                if (text[j] === '.' && !isDigit(text.charCodeAt(j + 1))) { break; }
                j++;
            }
            push('number', i, j);
            i = j;
            continue;
        }

        const multi = MULTI_PUNCT.find(p => text.startsWith(p, i));
        const len = multi ? multi.length : 1;
        push('punct', i, i + len);
        i += len;
    }

    return tokens;
}

/** Returns the end offset of a heredoc or nowdoc starting at `start`, or `start` if there is none. */
function readHeredoc(text: string, start: number): number {
    const header = /^<<<[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n/.exec(text.slice(start, start + 200));
    if (!header) { return start; }
    const label = header[2];
    let lineStart = start + header[0].length;
    while (lineStart <= text.length) {
        const nl = text.indexOf('\n', lineStart);
        const lineEnd = nl === -1 ? text.length : nl;
        const line = text.slice(lineStart, lineEnd);
        const trimmed = line.replace(/^[ \t]+/, '');
        if (trimmed.startsWith(label) && !/[A-Za-z0-9_]/.test(trimmed.charAt(label.length))) {
            return lineStart + (line.length - trimmed.length) + label.length;
        }
        if (nl === -1) { return text.length; }
        lineStart = nl + 1;
    }
    return text.length;
}

/** Tokens that carry meaning: everything except whitespace, comments, PHPDoc and HTML. */
export function isSignificant(token: Token): boolean {
    return token.kind !== 'ws' && token.kind !== 'comment' && token.kind !== 'doc' && token.kind !== 'html';
}
